const {randomUUID,createHash}=require('node:crypto');
const {ApiError}=require('./evolution.cjs');
const individual=/^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/;
const MAX_AGE=15*60_000;
const defaults=()=>({enabled:false,enabledSince:null,cooldownSeconds:60,rules:[]});
const settingsOf=data=>({...defaults(),...data.triggers?.settings});
const stateOf=data=>{data.triggers ||= {};const state=data.triggers;state.settings ||= defaults();state.processed ||= {};state.known ||= {};state.cooldowns ||= {};state.executions ||= [];return state;};
const claimKey=(jid,id)=>createHash('sha256').update(jid+'\0'+id).digest('hex');
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messageSignature=message=>fingerprint([message?.id,message?.fromMe,message?.type,message?.text??null,message?.timestamp,message?.caption??null]);
const identities=chat=>[...new Set([chat.jid,...(chat.aliasJids || []),...(chat.phone && /^\d{6,20}$/.test(chat.phone)?[chat.phone+'@s.whatsapp.net']:[])].filter(value=>individual.test(value || '')))];
const claimKeys=(ids,id)=>ids.map(jid=>claimKey(jid,id));
const contactName=chat=>{const value=typeof chat.name==='string'?chat.name.trim().slice(0,160):'';return !value || chat.nameSource==='number' || /^[\d+\s().-]+$/.test(value) || /^\d+@/.test(value)?'você':value;};
function enrollNewAudience(data,chat,history,at) {
  const settings=data.assistant,ids=identities(chat),message=chat.lastMessage;
  if(!settings?.enabled || settings.audience!=='new' || !settings.newCohort || !history?.firstContact || ids.some(id=>settings.known?.[id] || data.contacts?.[id]?.aiMode==='off') || !Number.isFinite(message?.timestamp) || message.timestamp<=Date.parse(settings.enabledSince || '') || message.timestamp>at+30000 || at-message.timestamp>MAX_AGE) return;
  settings.enrolled ||= {};settings.known ||= {};for(const id of ids) {settings.enrolled[id]={cohort:settings.newCohort,at:new Date(at).toISOString()};settings.known[id]=true;}
}
const normalize=text=>String(text).normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
function containsKeyword(text,keyword,match) {
  const source=normalize(text),term=normalize(keyword);let start=source.indexOf(term);
  while(start>=0) {if(match==='contains' || (!/[\p{L}\p{N}_]/u.test(Array.from(source.slice(0,start)).at(-1) || '') && !/[\p{L}\p{N}_]/u.test(Array.from(source.slice(start+term.length))[0] || ''))) return true;start=source.indexOf(term,start+1);}return false;
}
function outsideSchedule(rule,at) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:rule.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),time=Number(parts.hour)*60+Number(parts.minute),minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
  const {days,start,end}=rule.schedule,a=minute(start),b=minute(end);
  const open=a<b?days.includes(day)&&time>=a&&time<b:a>b?(days.includes(day)&&time>=a)||(days.includes((day+6)%7)&&time<b):days.includes(day);
  return !open;
}
function matchingRule(settings,context) {
  return settings.rules.find(rule=>rule.enabled && (rule.inactiveDays===null || context.previousMessageAt===null || (Number.isFinite(context.previousMessageAt) && context.at-context.previousMessageAt>=rule.inactiveDays*86400000)) && (rule.type==='first_contact'?context.firstContact:rule.type==='absence'?outsideSchedule(rule,context.at):rule.keywords.some(term=>containsKeyword(context.text,term,rule.match))));
}
function validateSettings(input) {
  const fail=message=>{throw new ApiError(message,422);};
  if(!input || typeof input!=='object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key=>!['enabled','cooldownSeconds','rules'].includes(key))) fail('Informe configurações válidas para os gatilhos.');
  const patch={};
  if(Object.hasOwn(input,'enabled')) {if(typeof input.enabled!=='boolean') fail('Escolha ativar ou desligar os gatilhos.');patch.enabled=input.enabled;}
  if(Object.hasOwn(input,'cooldownSeconds')) {if(!Number.isInteger(input.cooldownSeconds) || input.cooldownSeconds<10 || input.cooldownSeconds>86400) fail('O intervalo por contato deve ficar entre 10 e 86.400 segundos.');patch.cooldownSeconds=input.cooldownSeconds;}
  if(Object.hasOwn(input,'rules')) {
    if(!Array.isArray(input.rules) || input.rules.length>50) fail('Cadastre até 50 gatilhos.');let bytes=0;const ids=new Set();
    patch.rules=input.rules.map(rule=>{
      if(!rule || typeof rule!=='object' || Array.isArray(rule)) fail('Gatilho inválido.');
      const id=rule.id===undefined?randomUUID():rule.id;
      if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) fail('Cada gatilho precisa de um identificador único.');ids.add(id);
      if(typeof rule.name!=='string' || !rule.name.trim() || rule.name.length>80) fail('Dê um nome de até 80 caracteres ao gatilho.');
      if(!['first_contact','keyword','absence'].includes(rule.type)) fail('Escolha um tipo de gatilho válido.');
      if(rule.enabled!==undefined && typeof rule.enabled!=='boolean') fail('Ativação de gatilho inválida.');
      const keywords=rule.keywords || [];if(!Array.isArray(keywords) || keywords.length>50 || (rule.type==='keyword' && !keywords.length) || keywords.some(word=>typeof word!=='string' || !word.trim() || word.length>160)) fail('Informe de 1 a 50 palavras ou frases de até 160 caracteres.');
      const match=rule.match || 'contains';if(!['contains','word'].includes(match)) fail('Escolha como comparar as palavras.');
      const inactiveDays=rule.inactiveDays??null;if(inactiveDays!==null && (!Number.isInteger(inactiveDays) || inactiveDays<1 || inactiveDays>3650)) fail('A inatividade deve ficar entre 1 e 3.650 dias.');
      const delaySeconds=rule.delaySeconds??0;if(!Number.isInteger(delaySeconds) || delaySeconds<0 || delaySeconds>86400) fail('A espera deve ficar entre 0 e 86.400 segundos.');
      const timezone=rule.timezone || 'America/Sao_Paulo';try {new Intl.DateTimeFormat('pt-BR',{timeZone:timezone});}catch {fail('Escolha um fuso horário válido.');}
      const schedule=rule.schedule || {days:[1,2,3,4,5],start:'09:00',end:'18:00'};
      if(!schedule || !Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some(day=>!Number.isInteger(day) || day<0 || day>6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.start || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.end || '')) fail('Defina dias e horários de atendimento válidos.');
      if(!Array.isArray(rule.messages) || !rule.messages.length || rule.messages.length>10) fail('Adicione de 1 a 10 respostas ao gatilho.');
      const messages=rule.messages.map(message=>{
        if(!message || typeof message!=='object') fail('Resposta inválida.');
        if(message.type==='text') {if(typeof message.text!=='string' || !message.text.trim() || message.text.length>10000) fail('Escreva uma resposta de até 10.000 caracteres.');return {type:'text',text:message.text.trim()};}
        if(message.type==='poll') {
          if(typeof message.name!=='string' || !message.name.trim() || message.name.length>255 || !Array.isArray(message.options) || message.options.length<2 || message.options.length>10 || message.options.some(option=>typeof option!=='string' || !option.trim() || option.length>100) || new Set(message.options.map(option=>option.trim().toLocaleLowerCase('pt-BR'))).size!==message.options.length) fail('A enquete precisa de uma pergunta e de 2 a 10 opções diferentes.');
          const selectableCount=message.selectableCount??1;if(!Number.isInteger(selectableCount) || selectableCount<1 || selectableCount>message.options.length) fail('Quantidade de opções da enquete inválida.');return {type:'poll',name:message.name.trim(),options:message.options.map(option=>option.trim()),selectableCount};
        }
        if(!['audio','image','video','document'].includes(message.type) || typeof message.base64!=='string' || !message.base64.length || message.base64.length>14_000_000 || message.base64.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.base64)) fail('Adicione um arquivo válido em base64.');
        bytes+=Buffer.byteLength(message.base64,'base64');if(bytes>10*1024*1024) fail('Os anexos dos gatilhos podem somar até 10 MB.');
        if(typeof message.mimeType!=='string' || !/^[\w.+-]+\/[\w.+-]+$/.test(message.mimeType) || message.mimeType.length>100 || (message.type!=='document' && !message.mimeType.startsWith(message.type+'/'))) fail('Tipo de arquivo inválido.');
        if(typeof message.fileName!=='string' || !message.fileName.trim() || message.fileName.length>160 || /[\x00-\x1f\/\\]/.test(message.fileName) || (message.caption!==undefined && (typeof message.caption!=='string' || message.caption.length>2000))) fail('Nome de arquivo ou legenda inválidos.');
        return {type:message.type,base64:message.base64,mimeType:message.mimeType,fileName:message.fileName.trim(),caption:message.caption || ''};
      });
      return {id,name:rule.name.trim(),enabled:rule.enabled!==false,type:rule.type,keywords:[...new Set(keywords.map(word=>word.trim()))],match,inactiveDays,delaySeconds,timezone,schedule:{days:[...new Set(schedule.days)],start:schedule.start,end:schedule.end},messages};
    });
  }return patch;
}
async function inspectConversation(client,jid,message,{since=Infinity}={}) {
  let previousMessageAt=null,complete=false;
  for(let page=1;page<=20;page++) {
    const result=await client.messages(jid,page),rows=Array.isArray(result.messages)?result.messages:[];
    let existing=false;
    for(const row of rows) if(row.id!==message.id && Number.isFinite(Number(row.timestamp)) && Number(row.timestamp)<=message.timestamp && ['text','audio','image','video','document','sticker','poll','contact','location'].includes(row.type)) {previousMessageAt=Math.max(previousMessageAt??0,Number(row.timestamp));if(Number(row.timestamp)<=since || row.fromMe!==false) existing=true;}
    if(existing) return {previousMessageAt,firstContact:false};
    if(!rows.length || page>=(Number(result.pages)||1)) {complete=true;break;}
  }
  return {previousMessageAt,firstContact:complete};
}
function createTriggerService({store,client,now=Date.now,intervalMs=5000,humanizer=null}) {
  let baseline=now(),timer=null,running=null,stopped=false,generation=0,recovery=null,lastPollAt=null,lastError=null;
  const fresh=(message,settings)=>Number.isFinite(message.timestamp) && message.timestamp>Math.max(baseline,Date.parse(settings.enabledSince || '') || Infinity) && message.timestamp<=now()+30000 && now()-message.timestamp<=MAX_AGE;
  const valid=(message,jid)=>message?.fromMe===false && typeof message.id==='string' && message.id.length>0 && message.jid===jid && message.key?.id===message.id && message.key?.remoteJid===jid && message.key?.fromMe===false && ['text','audio','image','video','document','sticker','poll','contact','location'].includes(message.type);
  const finish=(id,status,extra={})=>store.update(data=>{const event=stateOf(data).executions.find(item=>item.id===id);if(event) {Object.assign(event,{status,updatedAt:new Date(now()).toISOString(),...extra});for(const key of event.claimKeys || [event.claimKey]) {const claim=data.replyClaims?.[key];if(claim?.owner==='triggers') claim.status=status;}}});
  async function recover() {
    if(!recovery) recovery=(async()=>{
      const data=await store.read();if(!data.triggers?.executions?.some(event=>['queued','sending'].includes(event.status) && Date.parse(event.createdAt)<=baseline)) return;
      await store.update(next=>{for(const event of stateOf(next).executions) if(['queued','sending'].includes(event.status) && Date.parse(event.createdAt)<=baseline) {event.status='uncertain';event.updatedAt=new Date(now()).toISOString();event.message='O processo foi interrompido. Confira a conversa; este envio não será repetido.';}});
    })();return recovery;
  }
  async function cancelReason(event,run) {
    const data=await store.read(),settings=settingsOf(data),rule=settings.rules.find(item=>item.id===event.ruleId);
    if(stopped || run!==generation) return 'skipped_stopped';
    if(!settings.enabled || settings.enabledSince!==event.enabledSince) return 'skipped_disabled';
    if(event.identities.some(jid=>data.contacts?.[jid]?.automationPaused===true)) return 'skipped_paused';
    if(!rule?.enabled || fingerprint(rule)!==event.ruleFingerprint) return 'skipped_changed';
    return null;
  }
  async function deliver(event,run) {
    let reason=await cancelReason(event,run);if(reason) {await finish(event.id,reason);return;}
    const rule=settingsOf(await store.read()).rules.find(item=>item.id===event.ruleId);
    const sentIds=event.sentMessageIds || [];
    for(let index=event.sentCount || 0;index<rule.messages.length;index++) {
      // Tempo de gente: espera aleatória (só se a regra não tiver atraso próprio; entre mensagens da sequência, uma pausa menor) e "digitando…" no texto. Depois, tudo é conferido de novo.
      const upcoming=rule.messages[index],human=humanizer?await humanizer.plan(upcoming.type==='text'?upcoming.text:''):{waitMs:0,typingMs:0};
      const pause=index===0?((rule.delaySeconds || 0)>0?0:human.waitMs):Math.round(human.waitMs/3);
      if(pause>0) await humanizer.sleep(pause);
      const chat=(await client.chats()).find(chat=>chat.jid===event.jid),last=chat?.lastMessage;
      reason=await cancelReason(event,run);
      if(!reason && (!last || (last.id===event.messageId?messageSignature(last)!==event.messageSignature:!sentIds.includes(last.id)))) reason='skipped_replied';
      if(reason) {await finish(event.id,reason);return;}
      const permitted=await store.update(data=>{
        const state=stateOf(data),saved=state.executions.find(item=>item.id===event.id),settings=settingsOf(data),latest=settings.rules.find(item=>item.id===event.ruleId);
        if(stopped || run!==generation || !saved || !['queued','sending'].includes(saved.status) || !settings.enabled || settings.enabledSince!==event.enabledSince || event.identities.some(jid=>data.contacts?.[jid]?.automationPaused===true) || !latest?.enabled || fingerprint(latest)!==event.ruleFingerprint) return false;
        if(index===0 && event.identities.some(jid=>state.cooldowns[jid]!==undefined && now()-state.cooldowns[jid]<settings.cooldownSeconds*1000)) {saved.status='skipped_cooldown';return false;}
        for(const jid of event.identities) state.cooldowns[jid]=now();saved.status='sending';saved.updatedAt=new Date(now()).toISOString();return true;
      });
      if(!permitted) {const why=await cancelReason(event,run);if(why) await finish(event.id,why);return;}
      reason=await cancelReason(event,run);if(reason) {await finish(event.id,reason);return;}
      try {
        const message=rule.messages[index];let result;
        if(message.type==='text') result=await client.sendText(event.jid,message.text.replace(/\{(?:nome|name)\}/g,()=>event.contactName || 'você'),{delay:human.typingMs});
        else if(message.type==='poll') {if(typeof client.sendPoll!=='function') throw new Error('Unsupported');result=await client.sendPoll(event.jid,{name:message.name,options:message.options,selectableCount:message.selectableCount});}
        else {const {type,...media}=message;result=await client.sendMedia(event.jid,{...media,mediaType:type});}
        if(!result?.id) throw new Error('Unconfirmed');sentIds.push(result.id);
        await finish(event.id,index===rule.messages.length-1?'sent':'sending',{sentCount:index+1,sentMessageIds:sentIds});
      }catch {await finish(event.id,'uncertain',{message:'Envio sem confirmação. Confira a conversa antes de responder novamente.'});return;}
    }
  }
  async function poll(run) {
    await recover();const snapshot=await store.read(),settings=settingsOf(snapshot);
    const queued=snapshot.triggers?.executions?.filter(event=>event.status==='queued') || [];
    for(const event of queued) {const reason=await cancelReason(event,run);if(reason) await finish(event.id,reason);else if(event.dueAt<=now()) await deliver(event,run);}
    if(stopped || run!==generation || !settings.enabled) return;
    const chats=(await client.chats()).filter(chat=>individual.test(chat.jid || ''));
    const historical=chats.filter(chat=>chat.lastMessage && Number(chat.lastMessage.timestamp)<=baseline);
    if(historical.length) await store.update(data=>{const state=stateOf(data);for(const chat of historical) for(const jid of identities(chat)) state.known[jid]=true;});
    for(const chat of chats.slice(0,200)) {
      if(stopped || run!==generation) return;const message=chat.lastMessage;
      if(!valid(message,chat.jid) || !fresh(message,settings)) continue;
      const ids=identities(chat),keys=claimKeys(ids,message.id),key=claimKey(chat.jid,message.id),data=await store.read();if(keys.some(key=>data.triggers?.processed?.[key] || data.replyClaims?.[key])) continue;
      const history=await inspectConversation(client,chat.jid,message,{since:Math.max(baseline,Date.parse(settings.enabledSince || '') || Infinity)}),context={...history,text:message.text || '',at:message.timestamp,firstContact:history.firstContact&&!ids.some(jid=>data.triggers?.known?.[jid])};
      const claim=await store.update(next=>{
        const state=stateOf(next),current=settingsOf(next);if(stopped || run!==generation || !current.enabled || !fresh(message,current) || keys.some(key=>state.processed[key] || next.replyClaims?.[key])) return null;
        const firstContact=context.firstContact&&!ids.some(jid=>state.known[jid]),rule=matchingRule(current,{...context,firstContact});
        enrollNewAudience(next,chat,{...history,firstContact},now());
        for(const jid of ids) state.known[jid]=true;
        for(const key of keys) state.processed[key]={at:message.timestamp};if(!rule) return null;
        const at=new Date(now()).toISOString(),event={id:randomUUID(),jid:chat.jid,identities:ids,contactName:contactName(chat),messageId:message.id,messageSignature:messageSignature(message),claimKey:key,claimKeys:keys,ruleId:rule.id,ruleName:rule.name,ruleFingerprint:fingerprint(rule),enabledSince:current.enabledSince,status:'queued',createdAt:at,updatedAt:at,dueAt:now()+rule.delaySeconds*1000,sentCount:0};
        next.replyClaims ||= {};for(const key of keys) next.replyClaims[key]={owner:'triggers',claimedAt:at,status:'queued'};state.executions.unshift(event);state.executions=state.executions.slice(0,200);return event;
      });
      if(claim && claim.dueAt<=now()) await deliver(claim,run);
    }
    lastPollAt=new Date(now()).toISOString();lastError=null;
  }
  const view=data=>({...settingsOf(data),running:!!timer,lastPollAt,lastError});
  const service={
    async settings(){await recover();return view(await store.read());},
    async saveSettings(input) {
      const patch=validateSettings(input);await recover();const prior=settingsOf(await store.read());
      const chats=patch.enabled===true&&!prior.enabled?await client.chats():[];
      return store.update(data=>{const state=stateOf(data),current=settingsOf(data),next={...current,...patch};if(next.enabled&&!current.enabled) {next.enabledSince=new Date(now()).toISOString();for(const chat of chats) if(chat.lastMessage) for(const jid of identities(chat)) state.known[jid]=true;}state.settings=next;return view(data);});
    },
    async simulate(input) {
      if(!input || typeof input.text!=='string' || input.text.length>10000 || (input.firstContact!==undefined && typeof input.firstContact!=='boolean')) throw new ApiError('Digite um texto de até 10.000 caracteres para testar.',422);
      const at=input.at===undefined?now():Date.parse(input.at),previousMessageAt=input.previousMessageAt==null?null:Date.parse(input.previousMessageAt);
      if(!Number.isFinite(at) || (previousMessageAt!==null && !Number.isFinite(previousMessageAt))) throw new ApiError('Informe datas válidas para a simulação.',422);
      const rule=matchingRule(settingsOf(await store.read()),{text:input.text,firstContact:input.firstContact===true,at,previousMessageAt});return rule?{matched:true,rule:{id:rule.id,name:rule.name},messages:rule.messages}:{matched:false,rule:null,messages:[]};
    },
    async executions(){await recover();return (await store.read()).triggers?.executions?.map(({ruleFingerprint,claimKey,identities,...event})=>event).slice(0,200) || [];},
    tick(){if(stopped) return Promise.resolve();if(running) return running;const run=generation;running=poll(run).catch(()=>{lastError='Não foi possível consultar os gatilhos. A próxima consulta acontecerá automaticamente.';}).finally(()=>{running=null;});return running;},
    start({poll=true}={}) {if(timer) return;stopped=false;generation++;baseline=now();if(poll) {timer=setInterval(()=>{void service.tick();},Math.max(1000,intervalMs));timer.unref?.();}},
    stop(){stopped=true;generation++;if(timer) clearInterval(timer);timer=null;},
    idle(){return running || Promise.resolve();}
  };return service;
}
module.exports={createTriggerService,claimKey,claimKeys,identities,inspectConversation,messageSignature,enrollNewAudience};
