const {randomUUID}=require('node:crypto');
const {ApiError}=require('./evolution.cjs');
const {claimKey,claimKeys,identities,messageSignature,inspectConversation,enrollNewAudience}=require('./triggers.cjs');
const individual=/^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/;
const defaults=()=>({enabled:false,enabledSince:null,cooldownSeconds:60,rules:[]});
const normalize=text=>String(text).normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
const settingsOf=data=>({...defaults(),...data.automation?.settings});
const stateOf=data=>{
  data.automation ||= {};const state=data.automation;
  state.settings ||= defaults();state.processed ||= {};state.cooldowns ||= {};state.executions ||= [];
  return state;
};
function matchingRule(settings,text) {
  const normalized=normalize(text);
  return settings.rules.find(rule=>rule.enabled && rule.keywords.some(keyword=>{
    const term=normalize(keyword);if(rule.match==='contains') return normalized.includes(term);
    let start=normalized.indexOf(term);
    while(start>=0) {
      const before=Array.from(normalized.slice(0,start)).at(-1) || '',after=Array.from(normalized.slice(start+term.length))[0] || '';
      if(!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
      start=normalized.indexOf(term,start+1);
    }
    return false;
  }));
}
function validateSettings(input) {
  const allowed=['enabled','cooldownSeconds','rules'];
  if(!input || typeof input!=='object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key=>!allowed.includes(key))) throw new ApiError('Informe configurações válidas para o robô.',422);
  const patch={};
  if(Object.hasOwn(input,'enabled')) {if(typeof input.enabled!=='boolean') throw new ApiError('Escolha ativar ou desligar o robô.',422);patch.enabled=input.enabled;}
  if(Object.hasOwn(input,'cooldownSeconds')) {if(!Number.isInteger(input.cooldownSeconds) || input.cooldownSeconds<10 || input.cooldownSeconds>86400) throw new ApiError('O intervalo por contato deve ficar entre 10 e 86.400 segundos.',422);patch.cooldownSeconds=input.cooldownSeconds;}
  if(Object.hasOwn(input,'rules')) {
    if(!Array.isArray(input.rules) || input.rules.length>100) throw new ApiError('Cadastre até 100 regras.',422);
    const ids=new Set();patch.rules=input.rules.map(rule=>{
      if(!rule || typeof rule!=='object' || Array.isArray(rule)) throw new ApiError('Regra inválida.',422);
      const id=rule.id===undefined?randomUUID():rule.id;
      if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new ApiError('Cada regra precisa de um identificador único.',422);ids.add(id);
      if(typeof rule.name!=='string' || !rule.name.trim() || rule.name.length>80) throw new ApiError('Dê um nome de até 80 caracteres a cada regra.',422);
      if(!Array.isArray(rule.keywords) || !rule.keywords.length || rule.keywords.length>50 || rule.keywords.some(word=>typeof word!=='string' || !word.trim() || word.length>160)) throw new ApiError('Cada regra precisa de 1 a 50 palavras ou frases de até 160 caracteres.',422);
      if(!['contains','word'].includes(rule.match)) throw new ApiError('Escolha como comparar as palavras-chave.',422);
      if(typeof rule.response!=='string' || !rule.response.trim() || rule.response.length>10000) throw new ApiError('Escreva uma resposta de até 10.000 caracteres.',422);
      if(rule.enabled!==undefined && typeof rule.enabled!=='boolean') throw new ApiError('Ativação da regra inválida.',422);
      return {id,name:rule.name.trim(),keywords:[...new Set(rule.keywords.map(word=>word.trim()))],match:rule.match,response:rule.response.trim(),enabled:rule.enabled!==false};
    });
  }
  return patch;
}
function createAutomationService({store,client,now=Date.now,intervalMs=5000}) {
  let baseline=now(),timer=null,running=null,stopped=false,generation=0,chatOffset=0,lastPollAt=null,lastError=null,recovery=null;
  const continuations=new Map(),scanned=new Map();
  const isFresh=(message,since)=>Number.isFinite(message.timestamp) && message.timestamp>Math.max(baseline,Date.parse(since || '') || Infinity) && message.timestamp<=now()+30000 && now()-message.timestamp<=15*60_000;
  function recover() {
    if(!recovery) recovery=(async()=>{
      const data=await store.read();
      if(!data.automation?.executions?.some(event=>['queued','sending'].includes(event.status) && Date.parse(event.createdAt)<=baseline)) return;
      await store.update(next=>{
        for(const event of stateOf(next).executions) if(['queued','sending'].includes(event.status) && Date.parse(event.createdAt)<=baseline) Object.assign(event,{status:'uncertain',updatedAt:new Date(now()).toISOString(),message:'O processo foi interrompido. Confira a conversa; este envio não será repetido automaticamente.'});
      });
    })();
    return recovery;
  }
  async function finish(id,status,extra={}) {
    await store.update(data=>{
      const event=stateOf(data).executions.find(item=>item.id===id);
      if(event) {Object.assign(event,{status,updatedAt:new Date(now()).toISOString(),...extra});for(const key of event.claimKeys || [claimKey(event.jid,event.messageId)]) {const claim=data.replyClaims?.[key];if(claim?.owner==='automation') claim.status=status;}}
    });
  }
  async function processMessage(jid,message,run,chat) {
    if(stopped || run!==generation || message.type!=='text' || typeof message.text!=='string' || !message.text.trim() || message.fromMe!==false || message.key?.fromMe!==false || message.key?.remoteJid!==jid || message.jid!==jid || typeof message.id!=='string' || !message.id || message.key?.id!==message.id) return;
    if(chat && Object.hasOwn(chat,'lastMessage') && messageSignature(chat.lastMessage)!==messageSignature(message)) return;
    const snapshot=await store.read(),settings=settingsOf(snapshot);
    if(!settings.enabled || !isFresh(message,settings.enabledSince) || !matchingRule(settings,message.text)) return;
    const history=snapshot.assistant?.enabled && snapshot.assistant.audience==='new'?await inspectConversation(client,jid,message,{since:Math.max(baseline,Date.parse(snapshot.assistant.enabledSince || '') || Infinity)}):null;
    const ids=identities({...chat,jid}),keys=claimKeys(ids,message.id),key=claimKey(jid,message.id);
    const claim=await store.update(data=>{
      const state=stateOf(data),current=settingsOf(data);
      if(stopped || run!==generation || !current.enabled || !isFresh(message,current.enabledSince) || keys.some(key=>state.processed[key] || data.replyClaims?.[key])) return null;
      const rule=matchingRule(current,message.text);if(!rule) return null;
      if(history) enrollNewAudience(data,{...chat,jid,lastMessage:message},history,now());
      const at=new Date(now()).toISOString();
      const event={id:randomUUID(),jid,identities:ids,claimKeys:keys,messageId:message.id,ruleId:rule.id,ruleName:rule.name,status:'queued',createdAt:at,updatedAt:at};
      // A reserva é persistida antes de qualquer envio, inclusive antes de falhas incertas.
      for(const key of keys) state.processed[key]={at:message.timestamp,executionId:event.id};
      data.replyClaims ||= {};for(const key of keys) data.replyClaims[key]={owner:'automation',claimedAt:at,status:'queued'};
      state.executions.unshift(event);state.executions=state.executions.slice(0,200);
      return {event,rule,enabledSince:current.enabledSince};
    });
    if(!claim) return;
    const prepared=await store.update(data=>{
      const state=stateOf(data),current=settingsOf(data),event=state.executions.find(item=>item.id===claim.event.id);
      if(!event) return false;
      let status;
      if(stopped || run!==generation) status='skipped_stopped';
      else if(!current.enabled || current.enabledSince!==claim.enabledSince || !isFresh(message,current.enabledSince)) status='skipped_disabled';
      else if(ids.some(id=>data.contacts?.[id]?.automationPaused===true)) status='skipped_paused';
      else {
        const latest=matchingRule(current,message.text);
        if(!latest || latest.id!==claim.rule.id || latest.response!==claim.rule.response) status='skipped_changed';
        else if(ids.some(id=>state.cooldowns[id]!==undefined && now()-state.cooldowns[id]<current.cooldownSeconds*1000)) status='skipped_cooldown';
      }
      event.updatedAt=new Date(now()).toISOString();
      if(status) {event.status=status;return false;}
      for(const id of ids) state.cooldowns[id]=now();event.status='sending';return true;
    });
    if(!prepared) return;
    // stop() também pode acontecer enquanto a escrita atômica termina.
    if(stopped || run!==generation) {await finish(claim.event.id,'skipped_stopped');return;}
    const latestChat=(await client.chats()).find(chat=>chat.jid===jid);
    const latestData=await store.read(),latestSettings=settingsOf(latestData),latestRule=matchingRule(latestSettings,message.text);
    let cancelled;
    if(!latestSettings.enabled || latestSettings.enabledSince!==claim.enabledSince) cancelled='skipped_disabled';
    else if([...new Set([...ids,...(latestChat?identities(latestChat):[])])].some(id=>latestData.contacts?.[id]?.automationPaused===true)) cancelled='skipped_paused';
    else if(!latestRule || latestRule.id!==claim.rule.id || latestRule.response!==claim.rule.response) cancelled='skipped_changed';
    else if(latestChat && Object.hasOwn(latestChat,'lastMessage') && messageSignature(latestChat.lastMessage)!==messageSignature(message)) cancelled='skipped_replied';
    else if(stopped || run!==generation) cancelled='skipped_stopped';
    if(cancelled) {await finish(claim.event.id,cancelled);return;}
    try {
      const sent=await client.sendText(jid,claim.rule.response);
      await finish(claim.event.id,'sent',{sentMessageId:sent?.id || null});
    } catch {
      await finish(claim.event.id,'uncertain',{message:'Envio sem confirmação. Confira a conversa antes de responder novamente.'});
    }
  }
  async function poll(run) {
    await recover();const settings=settingsOf(await store.read());if(stopped || !settings.enabled) return;
    const tokenOf=chat=>chat.lastMessage?.id?JSON.stringify([chat.lastMessage.id,chat.lastMessage.timestamp,chat.lastMessage.fromMe]):null;
    const chats=(await client.chats()).filter(chat=>{
      if(!individual.test(chat.jid || '')) return false;
      if(continuations.has(chat.jid)) return true;
      if(Object.hasOwn(chat,'lastMessage') && (!chat.lastMessage || !isFresh(chat.lastMessage,settings.enabledSince))) return false;
      const token=tokenOf(chat);return !token || scanned.get(chat.jid)!==token;
    });
    if(!chats.length) return;
    const batch=Array.from({length:Math.min(40,chats.length)},(_,i)=>chats[(chatOffset+i)%chats.length]);
    let requests=0,visited=0;
    for(const chat of batch) {
      if(stopped || run!==generation || requests>=40) break;
      visited++;
      const continuation=continuations.get(chat.jid),scanToken=continuation?.token || tokenOf(chat);
      const collected=[];let page=continuation?.page || 1,continueAt=null;
      for(let n=0;n<10 && requests<40;n++,page++) {
        if(stopped || run!==generation) return;
        const live=settingsOf(await store.read());if(!live.enabled) return;
        const result=await client.messages(chat.jid,page);requests++;
        const rows=Array.isArray(result.messages)?result.messages:[];
        collected.push(...rows);
        const timestamps=rows.map(row=>Number(row.timestamp)).filter(value=>Number.isFinite(value)&&value>0);
        const reachedBaseline=timestamps.length>0 && Math.min(...timestamps)<=Math.max(baseline,Date.parse(live.enabledSince || '') || Infinity);
        if(!rows.length || page>=(Number(result.pages)||1) || reachedBaseline) {continueAt=null;break;}
        continueAt=page+1;
      }
      collected.sort((a,b)=>a.timestamp-b.timestamp);
      for(const message of collected) {
        if(stopped || run!==generation) return;
        await processMessage(chat.jid,message,run,chat);
      }
      if(continueAt) continuations.set(chat.jid,{page:continueAt,token:scanToken});
      else {continuations.delete(chat.jid);if(scanToken) scanned.set(chat.jid,scanToken);}
    }
    chatOffset=(chatOffset+visited)%chats.length;
    lastPollAt=new Date(now()).toISOString();lastError=null;
  }
  const service={
    async settings() {await recover();return {...settingsOf(await store.read()),running:!!timer,lastPollAt,lastError};},
    async saveSettings(input) {
      const patch=validateSettings(input);
      await recover();
      return store.update(data=>{
        const state=stateOf(data),current=settingsOf(data),next={...current,...patch};
        if(next.enabled && !current.enabled) {
          next.enabledSince=new Date(now()).toISOString();continuations.clear();scanned.clear();
        }
        state.settings=next;return {...next,running:!!timer,lastPollAt,lastError};
      });
    },
    async simulate(input) {
      if(!input || typeof input.text!=='string' || input.text.length>10000) throw new ApiError('Digite um texto de até 10.000 caracteres para testar.',422);
      const rule=matchingRule(settingsOf(await store.read()),input.text);
      return rule?{matched:true,rule:{id:rule.id,name:rule.name},reply:rule.response}:{matched:false,rule:null,reply:null};
    },
    async executions() {await recover();return (await store.read()).automation?.executions?.slice(0,200) || [];},
    tick() {
      if(stopped) return Promise.resolve();if(running) return running;
      const run=generation;
      running=poll(run).catch(()=>{lastError='Não foi possível consultar o conector. A próxima consulta acontecerá automaticamente.';}).finally(()=>{running=null;});
      return running;
    },
    start({poll=true}={}) {
      if(timer) return;stopped=false;generation++;baseline=now();continuations.clear();scanned.clear();
      if(poll) {timer=setInterval(()=>{void service.tick();},Math.max(1000,intervalMs));timer.unref?.();}
    },
    stop() {stopped=true;generation++;if(timer) clearInterval(timer);timer=null;},
    idle() {return running || Promise.resolve();}
  };
  return service;
}
module.exports={createAutomationService};
