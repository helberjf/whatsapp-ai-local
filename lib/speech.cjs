const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {ApiError}=require('./evolution.cjs');
const runFile=promisify(execFile);

// Voz para as respostas em áudio. OpenAI (nuvem, opcional) ou a voz instalada no Windows (local, sem enviar o texto).
const PROVIDERS=['windows','openai'];
const OPENAI_VOICES=['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'];
const OPENAI_MODELS=['gpt-4o-mini-tts','tts-1','tts-1-hd'];
const DEFAULTS={provider:'windows',voice:'',openaiVoice:'nova',openaiModel:'gpt-4o-mini-tts',speed:1,instructions:'Fale em português do Brasil, com tom cordial, natural e no ritmo de uma conversa de WhatsApp.'};
const MAX_TEXT=1500;

function normalizeSpeech(input={},current=DEFAULTS) {
  const fail=message=>{throw new ApiError(message,422);};
  const next={...DEFAULTS,...current};
  if(input.provider!==undefined) {if(!PROVIDERS.includes(input.provider)) fail('Escolha a voz do Windows ou a OpenAI.');next.provider=input.provider;}
  if(input.voice!==undefined) {if(typeof input.voice!=='string' || input.voice.length>120 || /[\x00-\x1f"'`$;|&<>]/.test(input.voice)) fail('Nome de voz do Windows inválido.');next.voice=input.voice.trim();}
  if(input.openaiVoice!==undefined) {if(!OPENAI_VOICES.includes(input.openaiVoice)) fail('Escolha uma voz da OpenAI válida.');next.openaiVoice=input.openaiVoice;}
  if(input.openaiModel!==undefined) {if(!OPENAI_MODELS.includes(input.openaiModel)) fail('Escolha um modelo de voz da OpenAI válido.');next.openaiModel=input.openaiModel;}
  if(input.speed!==undefined) {const speed=Number(input.speed);if(!Number.isFinite(speed) || speed<0.5 || speed>2) fail('A velocidade da voz deve ficar entre 0,5 e 2.');next.speed=Math.round(speed*100)/100;}
  if(input.instructions!==undefined) {if(typeof input.instructions!=='string' || input.instructions.length>500) fail('As instruções da voz podem ter até 500 caracteres.');next.instructions=input.instructions.trim();}
  return next;
}

// Texto de chat vira fala: sem links longos, markdown nem emojis lidos letra a letra.
function speakable(text) {
  const clean=String(text || '').replace(/https?:\/\/\S+/g,'link enviado na conversa').replace(/[*_~`#>]+/g,'').replace(/\p{Extended_Pictographic}️?/gu,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  if(!clean) throw new ApiError('Não há texto para transformar em áudio.',422);
  if(clean.length>MAX_TEXT) throw new ApiError(`Respostas em áudio aceitam até ${MAX_TEXT} caracteres. Envie em texto ou resuma a resposta.`,422);
  return clean;
}

async function readLimited(response,limit) {
  let length=0;const chunks=[];
  for await(const chunk of response.body || []) {length+=chunk.length;if(length>limit) {await response.body?.cancel?.().catch(()=>{});throw new ApiError('O áudio gerado excedeu 10 MB.',502);}chunks.push(chunk);}
  return Buffer.concat(chunks);
}

async function openaiSpeech({text,settings,apiKey},fetchImpl=fetch) {
  if(!apiKey) throw new ApiError('Configure a chave da OpenAI (Transcrição de áudios ou Fluxo de voz) para usar a voz da OpenAI.',422);
  const body={model:settings.openaiModel,voice:settings.openaiVoice,input:text,response_format:'mp3',speed:settings.speed,...(settings.openaiModel==='gpt-4o-mini-tts' && settings.instructions?{instructions:settings.instructions}:{})};
  let response;
  try {response=await fetchImpl('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120_000),redirect:'error'});}
  catch {throw new ApiError('Não foi possível acessar a OpenAI para gerar o áudio. Confira a internet.',502);}
  if(!response.ok) {await response.body?.cancel?.().catch(()=>{});throw new ApiError(response.status===401?'A chave da OpenAI não foi aceita. Atualize nas configurações.':response.status===429?'A OpenAI atingiu o limite de uso ou saldo. Confira sua conta.':`A OpenAI não gerou o áudio (HTTP ${response.status}).`,response.status===401?422:502);}
  const bytes=await readLimited(response,10*1024*1024);
  if(bytes.length<64) throw new ApiError('A OpenAI retornou um áudio vazio.',502);
  return {bytes,mimeType:'audio/mpeg'};
}

function createSpeechEngines(options={}) {
  const execute=options.runFile || runFile,platform=options.platform || process.platform;
  const powershell=process.env.WHATSAPP_POWERSHELL || 'powershell.exe';
  const script=path.join(__dirname,'..','scripts','speak.ps1');
  async function withDirectory(callback) {
    const parent=path.resolve(options.temporaryRoot || os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'whatsapp-voice-'));
    try {return await callback(directory);}
    finally {
      const resolved=path.resolve(directory);
      if(path.dirname(resolved)!==parent || !path.basename(resolved).startsWith('whatsapp-voice-')) throw new Error('Diretório temporário inválido');
      await fs.rm(resolved,{recursive:true,force:true});
    }
  }
  async function windowsSpeech({text,settings}) {
    if(platform!=='win32') throw new ApiError('A voz do Windows só funciona com a central rodando no Windows. Escolha a OpenAI ou rode no Windows.',503);
    return withDirectory(async directory=>{
      const input=path.join(directory,'text.txt'),output=path.join(directory,'voice.wav');
      await fs.writeFile(input,text,{encoding:'utf8',mode:0o600});
      // Rate do SAPI vai de -10 a 10; 1× equivale a 0.
      const rate=String(Math.max(-10,Math.min(10,Math.round((settings.speed-1)*10))));
      try {await execute(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-TextFile',input,'-Output',output,'-Voice',settings.voice || '','-Rate',rate],{windowsHide:true,timeout:120_000,maxBuffer:256_000});}
      catch(error) {throw new ApiError(error.code==='ENOENT'?'PowerShell não encontrado para gerar a voz do Windows.':'A voz do Windows não conseguiu gerar o áudio. Confira se há uma voz em português instalada (Configurações → Hora e idioma → Fala).',503);}
      let bytes;try {bytes=await fs.readFile(output);}catch {throw new ApiError('A voz do Windows não gerou o arquivo de áudio.',503);}
      if(bytes.length<64 || bytes.toString('ascii',0,4)!=='RIFF') throw new ApiError('A voz do Windows gerou um áudio inválido.',503);
      if(bytes.length>10*1024*1024) throw new ApiError('O áudio gerado excedeu 10 MB. Use uma resposta menor.',422);
      return {bytes,mimeType:'audio/wav'};
    });
  }
  async function windowsVoices() {
    if(platform!=='win32') return [];
    try {
      const {stdout}=await execute(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-List'],{windowsHide:true,timeout:30_000,maxBuffer:256_000});
      const rows=JSON.parse(String(stdout || '[]').trim() || '[]');
      return (Array.isArray(rows)?rows:[rows]).filter(row=>row && typeof row.name==='string').map(row=>({name:row.name.slice(0,120),culture:typeof row.culture==='string'?row.culture.slice(0,20):'',gender:typeof row.gender==='string'?row.gender.slice(0,20):''})).slice(0,40);
    } catch {return [];}
  }
  return {
    windowsAvailable:platform==='win32',
    voices:windowsVoices,
    async synthesize({text,settings,apiKey}) {
      const config=normalizeSpeech({},settings),speech=speakable(text);
      const result=config.provider==='openai'?await openaiSpeech({text:speech,settings:config,apiKey},options.fetchImpl):await windowsSpeech({text:speech,settings:config});
      return {base64:result.bytes.toString('base64'),mimeType:result.mimeType,bytes:result.bytes.length,provider:config.provider};
    }
  };
}

module.exports={createSpeechEngines,normalizeSpeech,speakable,openaiSpeech,DEFAULTS,PROVIDERS,OPENAI_VOICES,OPENAI_MODELS,MAX_TEXT};
