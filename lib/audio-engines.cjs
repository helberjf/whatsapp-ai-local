const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {ApiError}=require('./evolution.cjs');
const runFile=promisify(execFile);
async function transcribeWithOpenAI({audio,settings},fetchImpl=fetch) {
  const body=new FormData();body.set('file',new Blob([audio],{type:'audio/wav'}),'audio.wav');body.set('model','gpt-transcribe');body.set('response_format','json');
  if(settings.language && settings.language!=='auto') body.append('languages[]',settings.language);
  try {
    const response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+settings.aiApiKey},body,signal:AbortSignal.timeout(180000),redirect:'error'});
    if(!response.ok) {await response.body?.cancel();throw new ApiError(response.status===401?'A chave da OpenAI não foi aceita. Atualize nas configurações.':response.status===429?'A OpenAI atingiu o limite de uso ou saldo. Confira sua conta.':`A OpenAI não concluiu a transcrição (HTTP ${response.status}).`,response.status===401?422:502);}
    let length=0;const chunks=[];
    for await(const chunk of response.body || []) {length+=chunk.length;if(length>1000000) {await response.body?.cancel().catch(()=>{});throw new ApiError('Resposta de transcrição excedeu o limite.',502);}chunks.push(chunk);}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(typeof result.text!=='string') throw new ApiError('A OpenAI retornou uma transcrição inválida.',502);
    return {text:result.text};
  } catch(error) {if(error instanceof ApiError) throw error;throw new ApiError('Não foi possível acessar a OpenAI. Confira internet e configurações.',502);}
}
async function pythonPath() {
  if(process.env.WHATSAPP_WHISPER_PYTHON) return process.env.WHATSAPP_WHISPER_PYTHON;
  const installed=path.join(process.env.LOCALAPPDATA || os.homedir(),'Programs','Python','Python310','python.exe');
  try {await fs.access(installed);return installed;}catch{return process.platform==='win32'?'python.exe':'python3';}
}
function createAudioEngines(options={}) {
  const execute=options.runFile || runFile;
  async function withAudio(bytes,callback) {
    const parent=path.resolve(options.temporaryRoot || os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'whatsapp-audio-'));
    try {
      const source=path.join(directory,'input.audio'),prepared=path.join(directory,'audio.wav');
      await fs.writeFile(source,bytes,{mode:0o600});
      try {await execute(process.env.WHATSAPP_FFMPEG || 'ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-i',source,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-t','601',prepared],{windowsHide:true,timeout:60000,maxBuffer:64000});}
      catch(error) {throw new ApiError(error.code==='ENOENT'?'Instale FFmpeg e deixe o comando ffmpeg disponível no Windows.':'Não foi possível decodificar este áudio. Ele pode estar incompleto ou em formato incompatível.',422);}
      if((await fs.stat(prepared)).size>600*32000+1024) throw new ApiError('Transcreva áudios de até 10 minutos.',422);
      return await callback(prepared,directory);
    } finally {
      const resolved=path.resolve(directory);
      if(path.dirname(resolved)!==parent || !path.basename(resolved).startsWith('whatsapp-audio-')) throw new Error('Diretório temporário inválido');
      await fs.rm(resolved,{recursive:true,force:true});
    }
  }
  return {
    whisperEngine:({bytes,settings})=>withAudio(bytes,async(prepared,directory)=>{
      const output=path.join(directory,'result.json');let processError;
      try {await execute(await pythonPath(),['-X','utf8',path.join(__dirname,'..','scripts','transcribe.py'),'--audio',prepared,'--output',output,'--model',settings.whisperModel,'--language',settings.language],{windowsHide:true,timeout:1200000,maxBuffer:1000000,env:{...process.env,PYTHONUTF8:'1'}});}catch(error) {processError=error;}
      let result;try {result=JSON.parse(await fs.readFile(output,'utf8'));}catch{}
      const messages={missing_whisper:'Instale openai-whisper no Python usado pela central. Consulte o README.',missing_model:`O modelo Whisper ${settings.whisperModel} não está instalado. Consulte o README para baixá-lo.`,transcription_failed:'O Whisper não conseguiu transcrever este áudio. Tente outro modelo ou confira a instalação.'};
      if(result?.error) throw new ApiError(messages[result.error] || messages.transcription_failed,503);
      if(processError || typeof result?.text!=='string') throw new ApiError(processError?.code==='ENOENT'?'Python não encontrado. Configure WHATSAPP_WHISPER_PYTHON ou instale Python com Whisper.':processError?.killed?'O Whisper excedeu 20 minutos. Use um áudio menor ou o modelo tiny/base.':messages.transcription_failed,503);
      return {text:result.text};
    }),
    aiEngine:({bytes,settings})=>withAudio(bytes,async prepared=>transcribeWithOpenAI({audio:await fs.readFile(prepared),settings},options.fetchImpl))
  };
}
module.exports={createAudioEngines,transcribeWithOpenAI};
