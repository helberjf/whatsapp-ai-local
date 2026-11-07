const {ApiError,assertJid}=require('./evolution.cjs');
const {normalizeSpeech,DEFAULTS:SPEECH_DEFAULTS,MAX_TEXT}=require('./speech.cjs');
const {messageSignature}=require('./triggers.cjs');

// Fluxo de voz: (1) transcreve sozinho os áudios recebidos, (2) a IA lê as transcrições como mensagens do cliente
// e (3) a IA responde em texto, em áudio ou no mesmo formato que o cliente usou. Cada etapa tem sua chave.
const FORMATS=['text','audio','mirror'];
const individual=/^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/;
const WINDOW_MS=2*3600_000,MAX_PER_TICK=5;
const defaults=()=>({autoTranscribe:false,transcribeProvider:'whisper',aiReadsAudio:false,replyFormat:'text',enabledSince:null,speech:{...SPEECH_DEFAULTS},log:[],spoken:{}});

function createVoiceFlow({store,client,transcriptions,speech,credentials,now=Date.now}) {
  const settingsOf=data=>{const value={...defaults(),...data.voiceFlow};value.speech=normalizeSpeech({},value.speech);return value;};
  let stopped=false,running=null;const scanned=new Map(),queued=new Set();
  const log=(data,entry)=>{data.voiceFlow ||= defaults();data.voiceFlow.log=[{at:new Date(now()).toISOString(),...entry},...(data.voiceFlow.log || [])].slice(0,60);};
  const openaiKey=async()=>{try {return await credentials?.get('openai');}catch {return null;}};
  const hasOpenai=async()=>{try {return Boolean(await credentials?.has('openai'));}catch {return false;}};

  async function view() {
    const value=settingsOf(await store.read());
    return {autoTranscribe:value.autoTranscribe,transcribeProvider:value.transcribeProvider,aiReadsAudio:value.aiReadsAudio,replyFormat:value.replyFormat,enabledSince:value.enabledSince,speech:value.speech,log:value.log.slice(0,20),openaiConfigured:await hasOpenai(),windowsAvailable:speech?.windowsAvailable===true,maxText:MAX_TEXT};
  }
  async function save(input) {
    if(!input || typeof input!=='object' || Array.isArray(input)) throw new ApiError('Configuração do fluxo de voz inválida.',422);
    const allowed=['autoTranscribe','transcribeProvider','aiReadsAudio','replyFormat','speech','openaiApiKey','removeOpenaiKey'];
    if(Object.keys(input).some(key=>!allowed.includes(key))) throw new ApiError('Configuração do fluxo de voz inválida.',422);
    for(const key of ['autoTranscribe','aiReadsAudio','removeOpenaiKey']) if(input[key]!==undefined && typeof input[key]!=='boolean') throw new ApiError('Use ligado ou desligado nas chaves do fluxo de voz.',422);
    if(input.transcribeProvider!==undefined && !['whisper','ai'].includes(input.transcribeProvider)) throw new ApiError('Escolha Whisper local ou IA para transcrever.',422);
    if(input.replyFormat!==undefined && !FORMATS.includes(input.replyFormat)) throw new ApiError('Escolha responder em texto, em áudio ou no mesmo formato do cliente.',422);
    if(input.openaiApiKey!==undefined && (typeof input.openaiApiKey!=='string' || !/^[\x21-\x7e]{8,512}$/.test(input.openaiApiKey))) throw new ApiError('Cole uma chave de API válida.',422);
    if(input.openaiApiKey && input.removeOpenaiKey) throw new ApiError('Escolha salvar ou remover a chave.',422);
    const current=settingsOf(await store.read()),speechConfig=input.speech===undefined?current.speech:normalizeSpeech(input.speech,current.speech);
    const provider=input.transcribeProvider ?? current.transcribeProvider;
    if((input.autoTranscribe ?? current.autoTranscribe) && provider==='ai' && (input.removeOpenaiKey || (!input.openaiApiKey && !await hasOpenai()))) throw new ApiError(input.removeOpenaiKey?'Desligue a transcrição automática por IA antes de remover a chave da OpenAI.':'Para transcrever com IA, salve antes a chave da OpenAI.',422);
    if(input.openaiApiKey) {if(!credentials) throw new ApiError('Banco seguro de credenciais indisponível.',503);try {await credentials.set('openai',input.openaiApiKey);}catch {throw new ApiError('Não foi possível proteger a chave com este usuário do Windows.',503);}}
    if(input.removeOpenaiKey) await credentials?.remove('openai').catch(()=>{});
    await store.update(data=>{
      const value=data.voiceFlow={...settingsOf(data)};
      if(input.autoTranscribe===true && !value.autoTranscribe) value.enabledSince=new Date(now()).toISOString();
      for(const key of ['autoTranscribe','transcribeProvider','aiReadsAudio','replyFormat']) if(input[key]!==undefined) value[key]=input[key];
      value.speech=speechConfig;
    });
    return view();
  }

  // Áudios recebidos depois de ligar a transcrição automática (e nas últimas 2 horas) entram na fila uma única vez.
  async function poll() {
    const data=await store.read(),settings=settingsOf(data);
    if(!settings.autoTranscribe || !transcriptions) return;
    const since=Math.max(Date.parse(settings.enabledSince || '') || Infinity,now()-WINDOW_MS);
    if(!Number.isFinite(since)) return;
    let added=0;
    for(const chat of (await client.chats()).filter(chat=>individual.test(chat.jid || '') && chat.lastMessage)) {
      if(stopped || added>=MAX_PER_TICK) return;
      const signature=messageSignature(chat.lastMessage);
      if(scanned.get(chat.jid)===signature || Number(chat.lastMessage.timestamp)<=since) continue;
      const page=await client.messages(chat.jid,1),rows=Array.isArray(page.messages)?page.messages:[];
      let pending=false;
      for(const message of rows) {
        if(message.type!=='audio' || message.fromMe!==false || message.deleted || !(Number(message.timestamp)>since) || typeof message.id!=='string') continue;
        const key=chat.jid+'|'+message.id;if(queued.has(key)) continue;
        if(added>=MAX_PER_TICK) {pending=true;break;}
        try {
          const job=await transcriptions.enqueue({jid:chat.jid,messageId:message.id,provider:settings.transcribeProvider,auto:true});
          queued.add(key);if(queued.size>5000) queued.delete(queued.values().next().value);
          if(job.auto===true && job.status==='queued') {added++;await store.update(next=>log(next,{jid:chat.jid,action:'transcribe',detail:'Áudio recebido enviado para transcrição automática.'}));}
        } catch(error) {
          if(error.status===429) {pending=true;break;}
          queued.add(key);await store.update(next=>log(next,{jid:chat.jid,action:'error',detail:error.status?error.message:'Não foi possível transcrever um áudio recebido.'}));
        }
      }
      if(!pending) scanned.set(chat.jid,signature);
    }
  }

  // Textos que a IA leu: transcrições concluídas e o texto das respostas que a própria central enviou em áudio.
  async function transcripts(jid) {
    assertJid(jid);const map=new Map(),data=await store.read();
    for(const [id,job] of (await transcriptions?.results?.(jid)) || []) if(job.status==='completed' && typeof job.text==='string' && job.text.trim()) map.set(id,job.text.trim());
    for(const [id,entry] of Object.entries(data.voiceFlow?.spoken || {})) if(entry?.jid===jid && typeof entry.text==='string') map.set(id,entry.text);
    return map;
  }
  async function transcriptStatus(jid,messageId) {return (await transcriptions?.results?.(jid))?.get(messageId) || null;}
  async function readsAudio() {return settingsOf(await store.read()).aiReadsAudio;}
  async function synthesize(text) {
    if(!speech) throw new ApiError('Voz indisponível nesta central.',503);
    const settings=settingsOf(await store.read()).speech;
    return speech.synthesize({text,settings,apiKey:settings.provider==='openai'?await openaiKey():null});
  }
  async function remember(jid,message,text) {
    if(!message?.id) return;
    await store.update(data=>{
      data.voiceFlow ||= defaults();const spoken=data.voiceFlow.spoken ||= {};spoken[message.id]={jid,text:String(text).slice(0,MAX_TEXT),at:now()};
      const ids=Object.keys(spoken);if(ids.length>500) for(const id of ids.sort((a,b)=>spoken[a].at-spoken[b].at).slice(0,ids.length-500)) delete spoken[id];
    });
  }
  // Envia uma resposta da IA no formato escolhido. Se a voz falhar antes do envio, a resposta segue em texto e isso fica no registro.
  async function reply(jid,text,{last,delay=0}={}) {
    const format=settingsOf(await store.read()).replyFormat,wantsAudio=format==='audio' || (format==='mirror' && last?.type==='audio');
    if(wantsAudio) {
      let audio=null,reason=null;
      try {audio=await synthesize(text);}catch(error) {reason=error.status?error.message:'Não foi possível gerar o áudio.';}
      if(audio) {
        const message=await client.sendVoice(jid,{base64:audio.base64,delay});
        await remember(jid,message,text);return {format:'audio',message};
      }
      await store.update(data=>log(data,{jid,action:'fallback',detail:'Resposta enviada em texto: '+reason}));
      return {format:'text',message:await client.sendText(jid,text,{delay}),fallback:reason};
    }
    return {format:'text',message:await client.sendText(jid,text,{delay})};
  }
  // Envio manual de um texto como mensagem de voz (botão "Enviar como áudio").
  async function speakAndSend(jid,text,{quotedId}={}) {
    assertJid(jid);const audio=await synthesize(text);
    const message=await client.sendVoice(jid,{base64:audio.base64,quotedId});await remember(jid,message,text);return message;
  }

  return {
    view,save,transcripts,transcriptStatus,readsAudio,synthesize,reply,speakAndSend,remember,
    tick() {if(stopped) return Promise.resolve();if(running) return running;running=poll().catch(()=>{}).finally(()=>{running=null;});return running;},
    start() {stopped=false;},
    stop() {stopped=true;},
    idle() {return running || Promise.resolve();}
  };
}
module.exports={createVoiceFlow,FORMATS};
