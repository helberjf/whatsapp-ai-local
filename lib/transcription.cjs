const {createHash}=require('node:crypto');
const {ApiError,assertJid}=require('./evolution.cjs');
const MODELS=['tiny','base','small','medium','large-v3'],LANGUAGES=['pt','auto','en','es'];
const DEFAULTS={whisperModel:'base',language:'pt'};
const AI_MODEL='gpt-transcribe';
function createTranscriptionService({store,mediaLoader,whisperEngine,aiEngine,credentials}) {
  let queue=Promise.resolve(),mutations=Promise.resolve();
  const ready=store.update(data=>{
    data.transcriptions ||= {};
    for(const job of Object.values(data.transcriptions)) if(['queued','running'].includes(job.status)) {job.status='failed';job.error='Transcrição interrompida ao fechar a central. Tente novamente se desejar.';job.updatedAt=Date.now();}
  });
  const serial=fn=>{const operation=mutations.then(()=>ready).then(fn);mutations=operation.catch(()=>{});return operation;};
  async function rawSettings() {return {...DEFAULTS,...(await store.read()).transcriptionSettings};}
  async function settings() {await ready;const value=await rawSettings();return {defaultProvider:'whisper',whisperModel:value.whisperModel,language:value.language,aiConfigured:credentials?await credentials.has('openai'):false,aiModel:AI_MODEL};}
  async function run(id,snapshot) {
    try {
      const job=await store.update(data=>{const job=data.transcriptions[id];job.status='running';job.updatedAt=Date.now();return job;});
      const media=await mediaLoader(job.jid,job.messageId);
      const mimeType=String(media.mimetype || media.mimeType || '').split(';')[0].trim().toLowerCase();
      if(!/^audio\/[a-z0-9.+-]+$/.test(mimeType)) throw new ApiError('Esta mensagem não contém um áudio disponível para transcrição.',422);
      const base64=String(media.base64 || '').replace(/^data:audio\/[^,]+,/,'').replace(/[\r\n]/g,'');
      if(Buffer.byteLength(base64,'base64')>10*1024*1024) throw new ApiError('O áudio deve ter no máximo 10 MB.',422);
      if(!base64 || base64.length%4 || /[^A-Za-z0-9+/=]/.test(base64) || Buffer.from(base64,'base64').toString('base64')!==base64) throw new ApiError('O conector não retornou um áudio válido.',422);
      const engine=job.provider==='ai'?aiEngine:whisperEngine;
      if(typeof engine!=='function') throw new ApiError('Motor de transcrição indisponível.',503);
      const engineSettings={...snapshot};
      if(job.provider==='ai') {engineSettings.aiApiKey=await credentials?.get('openai');if(!engineSettings.aiApiKey) throw new ApiError('Configure a chave da IA nas configurações de transcrição.',422);}
      const result=await engine({bytes:Buffer.from(base64,'base64'),mimeType,settings:engineSettings});
      const text=typeof result?.text==='string'?result.text.trim():'';
      if(text.length>200000) throw new ApiError('O texto transcrito excedeu o limite.',422);
      await store.update(data=>{Object.assign(data.transcriptions[id],{status:'completed',text,updatedAt:Date.now()});delete data.transcriptions[id].error;});
    } catch(error) {
      await store.update(data=>{Object.assign(data.transcriptions[id],{status:'failed',error:error instanceof ApiError?error.message:'Não foi possível transcrever este áudio. Tente novamente ou confira a instalação do Whisper.',updatedAt:Date.now()});});
    }
  }
  return {
    settings,
    saveSettings:input=>serial(async()=>{
      const allowed=['whisperModel','language','aiApiKey','removeAiKey'];
      if(Object.keys(input).some(key=>!allowed.includes(key))) throw new ApiError('Configuração de transcrição inválida.',422);
      if(input.whisperModel!==undefined && !MODELS.includes(input.whisperModel)) throw new ApiError('Modelo Whisper inválido.',422);
      if(input.language!==undefined && !LANGUAGES.includes(input.language)) throw new ApiError('Idioma inválido.',422);
      if(input.removeAiKey!==undefined && typeof input.removeAiKey!=='boolean') throw new ApiError('Configuração da chave inválida.',422);
      if(input.aiApiKey!==undefined && (typeof input.aiApiKey!=='string' || !/^[\x21-\x7e]{8,512}$/.test(input.aiApiKey))) throw new ApiError('Cole uma chave de API válida.',422);
      if(input.aiApiKey && input.removeAiKey) throw new ApiError('Escolha salvar ou remover a chave.',422);
      if(input.aiApiKey) {if(!credentials) throw new ApiError('Banco seguro de credenciais indisponível.',503);await credentials.set('openai',input.aiApiKey);}
      if(input.removeAiKey) await credentials?.remove('openai');
      await store.update(data=>{data.transcriptionSettings={...DEFAULTS,...data.transcriptionSettings,...(input.whisperModel?{whisperModel:input.whisperModel}:{}),...(input.language?{language:input.language}:{})};});
      return settings();
    }),
    list:async jid=>{assertJid(jid);await ready;return Object.values((await store.read()).transcriptions).filter(job=>job.jid===jid).sort((a,b)=>a.createdAt-b.createdAt);},
    enqueue:input=>serial(async()=>{
      const jid=assertJid(input.jid),messageId=input.messageId,provider=input.provider || 'whisper';
      if(typeof messageId!=='string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(messageId) || messageId.includes('..')) throw new ApiError('Identificador do áudio inválido.',422);
      if(!['whisper','ai'].includes(provider) || (input.retry!==undefined && typeof input.retry!=='boolean')) throw new ApiError('Provedor ou pedido de transcrição inválido.',422);
      const config=await rawSettings(),model=provider==='whisper'?config.whisperModel:AI_MODEL;
      const id=createHash('sha256').update(JSON.stringify([jid,messageId,provider,model,config.language])).digest('hex');
      const previous=(await store.read()).transcriptions[id];
      if(previous && !(previous.status==='failed' && input.retry===true)) return previous;
      if(provider==='ai' && (!credentials || !await credentials.has('openai'))) throw new ApiError('Configure a chave da IA nas configurações de transcrição.',422);
      const jobs=Object.values((await store.read()).transcriptions);
      if(jobs.filter(job=>['queued','running'].includes(job.status)).length>=20) throw new ApiError('A fila já tem 20 áudios. Aguarde antes de adicionar outro.',429);
      const job={id,jid,messageId,provider,model,language:config.language,status:'queued',createdAt:Date.now(),updatedAt:Date.now()};
      await store.update(data=>{data.transcriptions[id]=job;});
      queue=queue.then(()=>run(id,config));queue=queue.catch(()=>{});
      return job;
    }),
    idle:async()=>{await ready;await mutations;await queue;}
  };
}
module.exports={createTranscriptionService};
