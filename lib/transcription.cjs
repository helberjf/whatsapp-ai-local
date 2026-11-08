const {createHash}=require('node:crypto');
const {ApiError,assertJid}=require('./evolution.cjs');
const MODELS=['tiny','base','small','medium','large-v3'],LANGUAGES=['pt','auto','en','es'],ENGINES=['whisper','faster-whisper'];
// Motor local, quantos áudios transcrever ao mesmo tempo e o tamanho máximo da fila são configuráveis.
const DEFAULTS={whisperModel:'base',language:'pt',engine:'whisper',concurrency:1,maxQueue:100};
const LIMITS={concurrency:[1,4],maxQueue:[10,500]};
const AI_MODEL='gpt-transcribe';
function createTranscriptionService({store,mediaLoader,whisperEngine,aiEngine,credentials}) {
  let mutations=Promise.resolve(),active=0,draftCount=0;const waiting=[],running=new Set();
  const ready=store.update(data=>{
    data.transcriptions ||= {};
    const resume=[];
    for(const job of Object.values(data.transcriptions)) if(['queued','running'].includes(job.status)) {if(job.automatic && job.provider==='whisper') {job.status='queued';resume.push({...job});}else {job.status='failed';job.error='Transcrição interrompida ao fechar a central. Tente novamente se desejar.';}job.updatedAt=Date.now();}
    return resume;
  });
  // Transcrições automáticas interrompidas voltam para a fila com o motor, o modelo e o idioma de quando foram pedidas.
  ready.then(jobs=>{
    for(const job of jobs) {const faster=String(job.model).startsWith('faster-whisper:');const config={whisperModel:faster?job.model.slice('faster-whisper:'.length):job.model,engine:faster?'faster-whisper':'whisper',language:job.language};waiting.push(()=>run(job.id,config));}
    pump();
  }).catch(()=>{});
  const serial=fn=>{const operation=mutations.then(()=>ready).then(fn);mutations=operation.catch(()=>{});return operation;};
  async function rawSettings() {return {...DEFAULTS,...(await store.read()).transcriptionSettings};}
  async function settings() {
    await ready;const value=await rawSettings(),jobs=Object.values((await store.read()).transcriptions || {});
    return {defaultProvider:'whisper',whisperModel:value.whisperModel,language:value.language,engine:value.engine,concurrency:value.concurrency,maxQueue:value.maxQueue,limits:LIMITS,queued:jobs.filter(job=>job.status==='queued').length,running:jobs.filter(job=>job.status==='running').length,aiConfigured:credentials?await credentials.has('openai'):false,aiModel:AI_MODEL};
  }
  // Fila com vários áudios ao mesmo tempo, conforme a configuração lida a cada novo início.
  function pump() {
    (async()=>{
      const {concurrency}=await rawSettings();
      while(active<concurrency && waiting.length) {
        const work=waiting.shift();active++;
        const task=work().finally(()=>{active--;running.delete(task);pump();});running.add(task);
      }
    })().catch(()=>{});
  }
  async function checkQueue({maxQueue}) {
    const jobs=Object.values((await store.read()).transcriptions);
    if(draftCount+jobs.filter(job=>['queued','running'].includes(job.status)).length>=maxQueue) throw new ApiError(`A fila já tem ${maxQueue} áudios. Aguarde antes de adicionar outro.`,429);
  }
  async function transcribeDraft(bytes,mimeType) {
    const deadline=Date.now()+21*60_000;
    const {result}=await serial(async()=>{
      const config=await rawSettings();await checkQueue(config);
      if(draftCount>=config.concurrency+2) throw new ApiError('Aguarde a conclusão dos áudios em transcrição antes de enviar outro.',429);
      draftCount++;
      const result=new Promise((resolve,reject)=>{
        waiting.push(async()=>{
          try {
            if(typeof whisperEngine!=='function') throw new ApiError('Motor de transcrição indisponível.',503);
            if(Date.now()>=deadline) throw new ApiError('O prazo para transcrever e enviar o áudio terminou.',504);
            const output=await whisperEngine({bytes,mimeType,settings:config});
            if(Date.now()>=deadline) throw new ApiError('O prazo para transcrever e enviar o áudio terminou.',504);
            const text=typeof output?.text==='string'?output.text.trim():'';
            if(!text) throw new ApiError('Nenhuma fala foi detectada no áudio.',422);
            if(text.length>10000) throw new ApiError('A transcrição excede 10000 caracteres. Use um áudio menor.',422);
            resolve(text);
          } catch(error) {reject(error);}
          finally {draftCount--;}
        });
        pump();
      });
      return {result};
    });
    return result;
  }
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
  const service={
    discover:async(jid,messages)=>{
      const saved=await service.list(jid);
      for(const message of messages) {
        if(message.type!=='audio' || message.deleted) continue;
        const previous=saved.find(job=>job.messageId===message.id && job.provider==='whisper');
        const interrupted=previous?.status==='failed' && !previous.automatic && previous.error?.startsWith('Transcrição interrompida');
        if(previous && !interrupted) continue;
        try {await service.enqueue({jid,messageId:message.id,provider:'whisper',automatic:true,...(interrupted?{retry:true}:{})});}catch(error) {if(error.status===429) break;if(error.status!==422) throw error;}
      }
    },
    settings,
    transcribeDraft,
    saveSettings:input=>serial(async()=>{
      const allowed=['whisperModel','language','aiApiKey','removeAiKey','engine','concurrency','maxQueue'];
      if(Object.keys(input).some(key=>!allowed.includes(key))) throw new ApiError('Configuração de transcrição inválida.',422);
      if(input.engine!==undefined && !ENGINES.includes(input.engine)) throw new ApiError('Escolha o Whisper ou o faster-whisper.',422);
      for(const [key,[min,max]] of Object.entries(LIMITS)) if(input[key]!==undefined && (!Number.isInteger(input[key]) || input[key]<min || input[key]>max)) throw new ApiError(key==='concurrency'?`Transcreva de ${min} a ${max} áudios ao mesmo tempo.`:`A fila de transcrição aceita de ${min} a ${max} áudios.`,422);
      if(input.whisperModel!==undefined && !MODELS.includes(input.whisperModel)) throw new ApiError('Modelo Whisper inválido.',422);
      if(input.language!==undefined && !LANGUAGES.includes(input.language)) throw new ApiError('Idioma inválido.',422);
      if(input.removeAiKey!==undefined && typeof input.removeAiKey!=='boolean') throw new ApiError('Configuração da chave inválida.',422);
      if(input.aiApiKey!==undefined && (typeof input.aiApiKey!=='string' || !/^[\x21-\x7e]{8,512}$/.test(input.aiApiKey))) throw new ApiError('Cole uma chave de API válida.',422);
      if(input.aiApiKey && input.removeAiKey) throw new ApiError('Escolha salvar ou remover a chave.',422);
      if(input.aiApiKey) {if(!credentials) throw new ApiError('Banco seguro de credenciais indisponível.',503);await credentials.set('openai',input.aiApiKey);}
      if(input.removeAiKey) await credentials?.remove('openai');
      await store.update(data=>{data.transcriptionSettings={...DEFAULTS,...data.transcriptionSettings,...(input.whisperModel?{whisperModel:input.whisperModel}:{}),...(input.language?{language:input.language}:{}),...Object.fromEntries(['engine','concurrency','maxQueue'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]]))};});
      pump();return settings();
    }),
    list:async jid=>{assertJid(jid);await ready;return Object.values((await store.read()).transcriptions).filter(job=>job.jid===jid).sort((a,b)=>a.createdAt-b.createdAt);},
    // Melhor resultado por áudio (concluído > em andamento > falha), usado pelo fluxo de voz e pela IA.
    results:async jid=>{
      assertJid(jid);await ready;const rank={completed:3,running:2,queued:2,failed:1},best=new Map();
      for(const job of Object.values((await store.read()).transcriptions || {})) {
        if(job.jid!==jid) continue;const previous=best.get(job.messageId);
        if(!previous || (rank[job.status]||0)>(rank[previous.status]||0) || ((rank[job.status]||0)===(rank[previous.status]||0) && job.updatedAt>previous.updatedAt)) best.set(job.messageId,job);
      }
      return best;
    },
    enqueue:input=>serial(async()=>{
      const jid=assertJid(input.jid),messageId=input.messageId,provider=input.provider || 'whisper';
      if(typeof messageId!=='string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(messageId) || messageId.includes('..')) throw new ApiError('Identificador do áudio inválido.',422);
      if(!['whisper','ai'].includes(provider) || (input.retry!==undefined && typeof input.retry!=='boolean') || (input.auto!==undefined && typeof input.auto!=='boolean')) throw new ApiError('Provedor ou pedido de transcrição inválido.',422);
      const config=await rawSettings(),model=provider==='whisper'?(config.engine==='faster-whisper'?'faster-whisper:'+config.whisperModel:config.whisperModel):AI_MODEL;
      const id=createHash('sha256').update(JSON.stringify([jid,messageId,provider,model,config.language])).digest('hex');
      const previous=(await store.read()).transcriptions[id];
      if(previous && !(previous.status==='failed' && input.retry===true)) return previous;
      if(provider==='ai' && (!credentials || !await credentials.has('openai'))) throw new ApiError('Configure a chave da IA nas configurações de transcrição.',422);
      await checkQueue(config);
      // automatic: transcrição de todo áudio recebido (retomada ao reabrir); auto: pedida pelo fluxo de voz.
      const job={id,jid,messageId,provider,model,language:config.language,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),...(input.automatic===true && provider==='whisper'?{automatic:true}:{}),...(input.auto===true?{auto:true}:{})};
      await store.update(data=>{data.transcriptions[id]=job;});
      waiting.push(()=>run(id,config));pump();
      return job;
    }),
    idle:async()=>{await ready;await mutations;while(waiting.length || running.size) await (running.size?Promise.race([...running]):new Promise(resolve=>setTimeout(resolve,5)));}
  };
  return service;
}
module.exports={createTranscriptionService};
