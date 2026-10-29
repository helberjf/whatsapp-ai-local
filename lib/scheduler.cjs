const {createHash}=require('node:crypto');
const {ApiError,assertJid}=require('./evolution.cjs');
const GRACE_MS=15*60000;
const publicJob=job=>{const {requestHash,...value}=job;return value;};
function assertId(id) {if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new ApiError('Identificador do agendamento inválido.',422);return id;}
function messageText(text) {if(typeof text!=='string' || !text.trim() || text.length>10000) throw new ApiError('Escreva uma mensagem de até 10.000 caracteres.',422);return text.trim();}
function scheduledDate(value,now,checkFuture=true) {
  const match=typeof value==='string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
  const at=Date.parse(value);
  if(!match || +match[2]<1 || +match[2]>12 || +match[3]<1 || +match[3]>new Date(Date.UTC(+match[1],+match[2],0)).getUTCDate() || +match[4]>23 || +match[5]>59 || +(match[6]||0)>59 || !Number.isFinite(at) || (checkFuture && (at<now+5000 || at>now+366*86400000))) throw new ApiError('Escolha uma data e hora futuras, com fuso horário, dentro de um ano.',422);
  return new Date(at).toISOString();
}
function createScheduler({store,client,now=Date.now,intervalMs=5000}) {
  let timer=null,running=null,stopped=false,generation=0;
  const ready=store.update(data=>{
    data.scheduledMessages ||= {};
    for(const job of Object.values(data.scheduledMessages)) if(job.status==='sending') Object.assign(job,{status:'uncertain',updatedAt:new Date(now()).toISOString(),lastError:'A central foi interrompida durante o envio. Confira a conversa antes de criar outro agendamento.'});
  });ready.catch(()=>{});
  async function poll(run) {
    await ready;if(stopped || run!==generation) return;
    const jobs=Object.values((await store.read()).scheduledMessages).filter(job=>job.status==='scheduled' && Date.parse(job.scheduledAt)<=now()).sort((a,b)=>Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt)).slice(0,20);
    let online;
    for(const snapshot of jobs) {
      if(stopped || run!==generation) return;
      if(now()-Date.parse(snapshot.scheduledAt)>GRACE_MS) {
        await store.update(data=>{const job=data.scheduledMessages[snapshot.id];if(job.status==='scheduled' && now()-Date.parse(job.scheduledAt)>GRACE_MS) Object.assign(job,{status:'missed',updatedAt:new Date(now()).toISOString(),lastError:'O horário passou há mais de 15 minutos. Remarque esta mensagem para enviar.'});});continue;
      }
      if(online===undefined) {try {online=(await client.connection()).state==='connected';}catch {online=false;}}
      if(stopped || run!==generation) return;
      if(!online) {
        const lastError='Aguardando conexão com o WhatsApp. Após 15 minutos de atraso, será necessário remarcar.';
        await store.update(data=>{const job=data.scheduledMessages[snapshot.id];if(job.status==='scheduled' && job.lastError!==lastError) Object.assign(job,{lastError,updatedAt:new Date(now()).toISOString()});});continue;
      }
      const claimed=await store.update(data=>{
        const job=data.scheduledMessages[snapshot.id];
        if(stopped || run!==generation || job.status!=='scheduled' || Date.parse(job.scheduledAt)>now() || now()-Date.parse(job.scheduledAt)>GRACE_MS) return null;
        Object.assign(job,{status:'sending',updatedAt:new Date(now()).toISOString()});delete job.lastError;return publicJob(job);
      });
      if(!claimed) continue;
      if(stopped || run!==generation) {await store.update(data=>{Object.assign(data.scheduledMessages[claimed.id],{status:'scheduled',updatedAt:new Date(now()).toISOString()});});return;}
      try {
        const sent=await client.sendText(claimed.jid,claimed.text);
        await store.update(data=>{Object.assign(data.scheduledMessages[claimed.id],{status:'sent',sentMessageId:sent?.id || null,updatedAt:new Date(now()).toISOString()});});
      } catch {
        await store.update(data=>{Object.assign(data.scheduledMessages[claimed.id],{status:'uncertain',lastError:'Envio sem confirmação. Confira a conversa antes de criar outro agendamento.',updatedAt:new Date(now()).toISOString()});});
      }
    }
  }
  const service={
    async list(jid) {if(jid!==undefined && jid!==null && jid!=='') assertJid(jid);await ready;return Object.values((await store.read()).scheduledMessages).filter(job=>!jid || job.jid===jid).map(publicJob).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));},
    async create(input) {
      const jid=assertJid(input.jid),text=messageText(input.text),scheduledAt=scheduledDate(input.scheduledAt,now(),false),id=assertId(input.requestId);
      const requestHash=createHash('sha256').update(JSON.stringify([jid,text,scheduledAt])).digest('hex');await ready;
      return store.update(data=>{
        const previous=data.scheduledMessages[id];if(previous) {if(previous.requestHash!==requestHash) throw new ApiError('Este identificador já pertence a outra mensagem programada.',409);return publicJob(previous);}
        scheduledDate(scheduledAt,now());
        if(Object.values(data.scheduledMessages).filter(job=>['scheduled','sending'].includes(job.status)).length>=500) throw new ApiError('Você já tem 500 mensagens programadas. Aguarde ou cancele alguma.',429);
        const job={id,jid,text,scheduledAt,requestHash,status:'scheduled',createdAt:new Date(now()).toISOString(),updatedAt:new Date(now()).toISOString()};data.scheduledMessages[id]=job;return publicJob(job);
      });
    },
    async update(id,input) {
      assertId(id);if(!input || !Object.keys(input).length || Object.keys(input).some(key=>!['text','scheduledAt'].includes(key))) throw new ApiError('Atualize apenas texto e horário.',422);
      const patch={};if(input.text!==undefined) patch.text=messageText(input.text);if(input.scheduledAt!==undefined) patch.scheduledAt=scheduledDate(input.scheduledAt,now());await ready;
      return store.update(data=>{
        const job=data.scheduledMessages[id];if(!job) throw new ApiError('Agendamento não encontrado.',404);
        if(!['scheduled','missed','cancelled'].includes(job.status)) throw new ApiError('O envio já começou ou ficou sem confirmação. Confira a conversa.',409);
        if(job.status!=='scheduled' && !patch.scheduledAt) throw new ApiError('Escolha um novo horário para remarcar.',422);
        Object.assign(job,patch,{status:'scheduled',updatedAt:new Date(now()).toISOString()});delete job.lastError;return publicJob(job);
      });
    },
    async cancel(id) {assertId(id);await ready;return store.update(data=>{const job=data.scheduledMessages[id];if(!job) throw new ApiError('Agendamento não encontrado.',404);if(job.status==='cancelled') return publicJob(job);if(job.status!=='scheduled') throw new ApiError('Este agendamento já não está aguardando envio.',409);Object.assign(job,{status:'cancelled',updatedAt:new Date(now()).toISOString()});delete job.lastError;return publicJob(job);});},
    tick() {if(stopped) return Promise.resolve();if(running) return running;const run=generation;running=poll(run).finally(()=>running=null);return running;},
    start() {if(timer) return;stopped=false;generation++;timer=setInterval(()=>{service.tick().catch(()=>{});},Math.max(1000,intervalMs));timer.unref?.();},
    stop() {stopped=true;generation++;if(timer) clearInterval(timer);timer=null;},
    idle:async()=>{await ready;await running;}
  };
  return service;
}
module.exports={createScheduler};
