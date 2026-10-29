const {ApiError,assertJid}=require('./evolution.cjs');
const {randomUUID}=require('node:crypto');
const knowledge=require('./knowledge.cjs');
const core=require('./assistant-core.cjs');
const {claimKeys,identities,inspectConversation,messageSignature}=require('./triggers.cjs');

const MODES=['off','draft','auto'];
const AUDIENCES=['classified','all','new'];
const HOURLY_CAP=6,MIN_GAP_MS=20_000;
const individual=/^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/;
const contactBase=()=>({status:'open',labels:[],notes:[]});

// Define a classificação do contato. Só mensagens recebidas depois dela são respondidas ou rascunhadas.
function applyMode(contact,mode,at=new Date().toISOString()) {
  if(!MODES.includes(mode)) throw new ApiError('Modo de IA inválido.',422);
  if(mode!=='off' && contact.aiMode!==mode) contact.aiSince=at;
  contact.aiMode=mode;
  if(mode==='off') contact.aiDraft=null;
  return contact;
}

// IA no atendimento: rascunhos prontos e respostas automáticas apenas para contatos classificados.
function createAssistantService({store,client,ai,loadTexts,catalogText,now=Date.now,intervalMs=8000}) {
  const settingsOf=data=>({enabled:false,enabledSince:null,audience:'classified',log:[],...data.assistant,rules:core.rulesOf(data.assistant)});
  let timer=null,busy=false,stopped=false,baseline=now(),generation=0,running=null;
  const modeFor=(contact,settings)=>contact?.aiMode==='off'?null:settings.audience==='classified'?(['draft','auto'].includes(contact?.aiMode)?contact.aiMode:null):settings.enabled?(contact?.aiMode || 'auto'):(['draft','auto'].includes(contact?.aiMode)?contact.aiMode:null);
  const fresh=(last,contact,settings)=>Number.isFinite(Number(last.timestamp)) && last.timestamp<=now()+30000 && now()-last.timestamp<=15*60_000 && (settings.audience==='classified'?Number(last.timestamp)>Math.max(baseline,Date.parse(contact?.aiSince || '') || Infinity):Number(last.timestamp)>Math.max(baseline,Date.parse(settings.enabledSince || '') || Infinity));
  const enrolled=(data,ids,settings)=>!!settings.newCohort && ids.some(id=>data.assistant?.enrolled?.[id]?.cohort===settings.newCohort);
  const canContinue=(data,jid,last,claim,run)=>!stopped && run===generation && settingsOf(data).audience===claim.audience && settingsOf(data).enabledSince===claim.enabledSince && modeFor(data.contacts?.[jid],settingsOf(data))===claim.mode && !claim.identities.some(id=>data.contacts?.[id]?.automationPaused===true || data.contacts?.[id]?.aiMode==='off') && fresh(last,data.contacts?.[jid],settingsOf(data));

  const log=(data,entry)=>{data.assistant ||= {};data.assistant.log=[{at:new Date(now()).toISOString(),...entry},...(data.assistant.log || [])].slice(0,100);};

  async function conversation(jid) {
    const result=await client.messages(jid,1);
    const rows=(Array.isArray(result.messages)?result.messages:[]).filter(message=>message.type==='text' && typeof message.text==='string' && message.text.trim()).sort((a,b)=>a.timestamp-b.timestamp).slice(-14);
    let split=rows.length;while(split>0 && rows[split-1].fromMe===false) split--;
    const pending=rows.slice(split);if(!pending.length) return null;
    const turns=[];
    for(const message of rows.slice(0,split)) turns.push({role:message.fromMe?'assistant':'user',content:message.text});
    const question=pending.map(message=>message.text).join('\n');
    turns.push({role:'user',content:question});
    // Papéis consecutivos iguais viram uma só vez, e a conversa começa sempre pelo cliente.
    const merged=[];
    for(const turn of turns) {if(merged.at(-1)?.role===turn.role) merged.at(-1).content+='\n'+turn.content;else merged.push({...turn});}
    while(merged[0]?.role==='assistant') merged.shift();
    return {messages:merged,question,lastId:pending.at(-1).id};
  }
  async function generate(conv) {
    const sources=knowledge.search(await loadTexts(),conv.question,4),data=await store.read();
    const raw=await ai.complete({system:core.buildSystem({rules:settingsOf(data).rules,catalog:await catalogText(),sources}),messages:conv.messages,maxTokens:500});
    const handoff=raw.includes(core.HANDOFF);
    return {text:handoff?'':raw.trim(),handoff,sources:sources.map(item=>({doc:item.docName,relevance:item.relevance}))};
  }

  async function processChat(jid,chat,run) {
    const last=chat.lastMessage,ids=identities(chat),keys=claimKeys(ids,last.id),snapshot=await store.read(),settings=settingsOf(snapshot);
    if(keys.some(key=>snapshot.replyClaims?.[key]) || ids.some(id=>snapshot.contacts?.[id]?.automationPaused===true || snapshot.contacts?.[id]?.aiMode==='off')) return;
    let firstContact=true;
    if(settings.audience==='new' && !enrolled(snapshot,ids,settings)) {
      if(ids.some(id=>snapshot.assistant?.known?.[id])) return;
      firstContact=(await inspectConversation(client,jid,last,{since:Math.max(baseline,Date.parse(settings.enabledSince || '') || Infinity)})).firstContact;if(!firstContact) {await store.update(data=>{data.assistant ||= {};data.assistant.known ||= {};for(const id of ids) data.assistant.known[id]=true;});return;}
    }
    const claim=await store.update(data=>{
      const current=settingsOf(data),mode=modeFor(data.contacts?.[jid],current),contact=data.contacts?.[jid];
      if(stopped || run!==generation || !mode || contact?.aiHandled===last.id || ids.some(id=>data.contacts?.[id]?.automationPaused===true || data.contacts?.[id]?.aiMode==='off') || keys.some(key=>data.replyClaims?.[key]) || !fresh(last,contact,current) || (current.audience==='new' && !enrolled(data,ids,current) && (!firstContact || ids.some(id=>data.assistant?.known?.[id])))) return null;
      data.contacts ||= {};data.contacts[jid] ||= contactBase();
      // A reserva vem antes de qualquer geração ou envio: a mesma mensagem nunca é tratada duas vezes.
      data.contacts[jid].aiHandled=last.id;
      data.assistant ||= {};data.assistant.known ||= {};for(const id of ids) data.assistant.known[id]=true;
      if(current.audience==='new') {data.assistant.enrolled ||= {};for(const id of ids) data.assistant.enrolled[id]={cohort:current.newCohort,at:new Date(now()).toISOString()};}
      data.replyClaims ||= {};for(const key of keys) data.replyClaims[key]={owner:'assistant',claimedAt:new Date(now()).toISOString(),status:'generating'};
      return {mode,enabled:current.enabled,audience:current.audience,enabledSince:current.enabledSince,identities:ids};
    });
    if(!claim) return;
    const wantsSend=claim.mode==='auto' && claim.enabled;
    try {
      const conv=await conversation(jid);if(!conv || conv.lastId!==last.id) return;
      const out=await generate(conv);
      if(!canContinue(await store.read(),jid,last,claim,run)) return;
      if(out.handoff) {
        await store.update(data=>{const contact=data.contacts[jid];contact.status='pending';contact.labels=[...new Set([...(contact.labels || []),'Atendente'])].slice(0,10);contact.aiDraft=null;log(data,{jid,mode:claim.mode,action:'handoff',detail:'A IA pediu atendimento humano.'});});
        return;
      }
      if(!out.text) return;
      const saveDraft=(note)=>store.update(data=>{if(!canContinue(data,jid,last,claim,run)) return;const contact=data.contacts[jid];contact.aiDraft={messageId:last.id,text:out.text,at:new Date(now()).toISOString()};for(const key of keys) if(data.replyClaims?.[key]?.owner==='assistant') data.replyClaims[key].status='draft';log(data,{jid,mode:claim.mode,action:'draft',detail:note || 'Rascunho preparado.'});});
      if(!wantsSend) {await saveDraft(claim.mode==='auto'?'Resposta automática desligada: rascunho preparado.':undefined);return;}
      // Antes de enviar: o contato ainda está em automático, a chave geral segue ligada e ninguém respondeu no meio do caminho.
      const gate=await store.update(data=>{
        const contact=data.contacts[jid],recent=[...new Set(ids.flatMap(id=>data.contacts?.[id]?.aiSent || []))].filter(time=>now()-time<3_600_000).sort((a,b)=>a-b);
        if(!canContinue(data,jid,last,claim,run) || modeFor(contact,settingsOf(data))!=='auto' || !settingsOf(data).enabled) return 'mode';
        if(recent.length>=HOURLY_CAP || (recent.length && now()-recent.at(-1)<MIN_GAP_MS)) return 'limit';
        contact.aiSent=[...recent,now()];return 'ok';
      });
      if(gate!=='ok') {await saveDraft(gate==='limit'?'Limite de respostas automáticas: rascunho preparado.':undefined);return;}
      const fresh=(await client.chats()).find(item=>item.jid===jid);
      if(messageSignature(fresh?.lastMessage)!==messageSignature(last)) return;
      const finalData=await store.read();if(!canContinue(finalData,jid,last,claim,run) || !settingsOf(finalData).enabled) return;
      try {
        await client.sendText(jid,out.text);
        await store.update(data=>{data.contacts[jid].aiDraft=null;for(const key of keys) if(data.replyClaims?.[key]?.owner==='assistant') data.replyClaims[key].status='sent';log(data,{jid,mode:'auto',action:'sent',detail:out.text.slice(0,160)});});
      } catch {
        await store.update(data=>{for(const key of keys) if(data.replyClaims?.[key]?.owner==='assistant') data.replyClaims[key].status='uncertain';log(data,{jid,mode:'auto',action:'error',detail:'Envio sem confirmação. Confira a conversa antes de responder novamente.'});});
      }
    } catch(error) {
      await store.update(data=>{log(data,{jid,mode:claim.mode,action:'error',detail:'Não foi possível preparar a resposta. Confira a configuração da IA.'});}).catch(()=>{});
    }
  }

  async function poll() {
    if(busy || stopped) return;busy=true;
    try {
      const run=generation,data=await store.read(),settings=settingsOf(data);
      if((settings.audience==='classified' || !settings.enabled) && !Object.values(data.contacts || {}).some(contact=>['draft','auto'].includes(contact.aiMode))) return;
      if(!(await ai.config()).configured) return;
      const chatRows=(await client.chats()).filter(chat=>individual.test(chat.jid || '')),chats=new Map(chatRows.map(chat=>[chat.jid,chat]));
      if(settings.audience!=='classified') {
        const old=chatRows.filter(chat=>chat.lastMessage && Number(chat.lastMessage.timestamp)<=baseline);
        if(old.length) await store.update(next=>{next.assistant ||= {};next.assistant.known ||= {};for(const chat of old) for(const id of identities(chat)) next.assistant.known[id]=true;});
      }
      for(const [jid,chat] of chats) {
        if(stopped) return;
        const contact=data.contacts?.[jid],last=chat?.lastMessage;if(!modeFor(contact,settings)) continue;
        if(!last) continue;
        if(last.fromMe) {if(contact?.aiDraft) await store.update(next=>{if(next.contacts[jid]) next.contacts[jid].aiDraft=null;});continue;}
        if(last.fromMe!==false || last.type!=='text' || !last.text?.trim() || typeof last.id!=='string' || (last.key && (last.key.id!==last.id || last.key.remoteJid!==jid || last.key.fromMe!==false))) continue;
        if(!fresh(last,contact,settings)) continue;
        await processChat(jid,chat,run);
      }
    } catch {/* o próximo ciclo tenta novamente */}
    finally {busy=false;}
  }

  async function handle(req,route,url,readBody) {
    const ok=(body,status=200)=>({status,body});
    const view=async()=>{
      const data=await store.read(),settings=settingsOf(data),modes=Object.values(data.contacts || {}).map(contact=>contact.aiMode);
      return ok({enabled:settings.enabled,enabledSince:settings.enabledSince,audience:settings.audience,rules:settings.rules,log:settings.log.slice(0,20),counts:{draft:modes.filter(mode=>mode==='draft').length,auto:modes.filter(mode=>mode==='auto').length},ai:(await ai.config()).configured});
    };
    if(route==='/api/assistant' && req.method==='GET') return view();
    if(route==='/api/assistant' && req.method==='PUT') {
      const input=await readBody(req);
      const rules=input.rules===undefined?undefined:core.normalizeRules(input.rules);
      if(input.enabled!==undefined && typeof input.enabled!=='boolean') throw new ApiError('Valor inválido para a chave geral.',422);
      if(input.audience!==undefined && !AUDIENCES.includes(input.audience)) throw new ApiError('Escolha um público válido para a IA.',422);
      const before=settingsOf(await store.read()),nextAudience=input.audience??before.audience,broadOptIn=(input.enabled===true&&!before.enabled || nextAudience!==before.audience) && nextAudience!=='classified';
      const known=broadOptIn?await client.chats():[];
      await store.update(data=>{
        data.assistant ||= {};
        if(rules) data.assistant.rules=rules;
        if(input.audience!==undefined) data.assistant.audience=input.audience;
        if(nextAudience==='new' && (before.audience!=='new' || !data.assistant.newCohort)) data.assistant.newCohort=randomUUID();
        if(broadOptIn) {data.assistant.enabledSince=new Date(now()).toISOString();data.assistant.known ||= {};for(const chat of known) if(chat.lastMessage) for(const id of identities(chat)) data.assistant.known[id]=true;}
        if(input.enabled!==undefined) {if(input.enabled && !settingsOf(data).enabled) data.assistant.enabledSince=new Date(now()).toISOString();data.assistant.enabled=input.enabled;}
      });
      return view();
    }
    if(route==='/api/assistant/classify' && req.method==='POST') {
      const input=await readBody(req);
      if(!Array.isArray(input.jids) || !input.jids.length || input.jids.length>1000) throw new ApiError('Selecione de 1 a 1000 contatos.',422);
      const jids=[...new Set(input.jids.map(assertJid))];
      if(!MODES.includes(input.aiMode)) throw new ApiError('Modo de IA inválido.',422);
      await store.update(data=>{for(const jid of jids) data.contacts[jid]=applyMode({...contactBase(),...data.contacts[jid]},input.aiMode);});
      return ok({updated:jids.length});
    }
    if(route==='/api/assistant/draft' && req.method==='POST') {
      const input=await readBody(req),jid=assertJid(input.jid);
      const conv=await conversation(jid);
      if(!conv) throw new ApiError('Não há mensagem do cliente aguardando resposta nesta conversa.',409);
      return ok(await generate(conv));
    }
    return undefined;
  }
  return {
    handle,applyMode,
    tick() {if(stopped) return Promise.resolve();if(running) return running;running=poll().finally(()=>{running=null;});return running;},
    start({poll:pollTimer=true}={}) {if(timer) return;stopped=false;generation++;baseline=now();if(pollTimer) {timer=setInterval(()=>{void this.tick();},intervalMs);timer.unref?.();}},
    stop() {stopped=true;generation++;clearInterval(timer);timer=null;},
    idle() {return running || Promise.resolve();}
  };
}
module.exports={createAssistantService,applyMode,MODES,AUDIENCES};
