const {ApiError,assertJid}=require('./evolution.cjs');
const knowledge=require('./knowledge.cjs');
const core=require('./assistant-core.cjs');

const MODES=['off','draft','auto'];
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
  const settingsOf=data=>({enabled:false,enabledSince:null,log:[],...data.assistant,rules:core.rulesOf(data.assistant)});
  let timer=null,busy=false,stopped=false;

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

  async function processChat(jid,chat) {
    const last=chat.lastMessage;
    const claim=await store.update(data=>{
      const contact=data.contacts?.[jid];
      if(!contact || !['draft','auto'].includes(contact.aiMode) || contact.aiHandled===last.id || contact.automationPaused===true) return null;
      // A reserva vem antes de qualquer geração ou envio: a mesma mensagem nunca é tratada duas vezes.
      contact.aiHandled=last.id;
      return {mode:contact.aiMode,enabled:settingsOf(data).enabled};
    });
    if(!claim) return;
    const wantsSend=claim.mode==='auto' && claim.enabled;
    try {
      const conv=await conversation(jid);if(!conv) return;
      const out=await generate(conv);
      if(out.handoff) {
        await store.update(data=>{const contact=data.contacts[jid];contact.status='pending';contact.labels=[...new Set([...(contact.labels || []),'Atendente'])].slice(0,10);contact.aiDraft=null;log(data,{jid,mode:claim.mode,action:'handoff',detail:'A IA pediu atendimento humano.'});});
        return;
      }
      if(!out.text) return;
      const saveDraft=(note)=>store.update(data=>{const contact=data.contacts[jid];contact.aiDraft={messageId:last.id,text:out.text,at:new Date(now()).toISOString()};log(data,{jid,mode:claim.mode,action:'draft',detail:note || 'Rascunho preparado.'});});
      if(!wantsSend) {await saveDraft(claim.mode==='auto'?'Resposta automática desligada: rascunho preparado.':undefined);return;}
      // Antes de enviar: o contato ainda está em automático, a chave geral segue ligada e ninguém respondeu no meio do caminho.
      const gate=await store.update(data=>{
        const contact=data.contacts[jid],recent=(contact.aiSent || []).filter(time=>now()-time<3_600_000);
        if(contact.aiMode!=='auto' || !settingsOf(data).enabled) return 'mode';
        if(recent.length>=HOURLY_CAP || (recent.length && now()-recent.at(-1)<MIN_GAP_MS)) return 'limit';
        contact.aiSent=[...recent,now()];return 'ok';
      });
      if(gate!=='ok') {await saveDraft(gate==='limit'?'Limite de respostas automáticas: rascunho preparado.':undefined);return;}
      const fresh=(await client.chats()).find(item=>item.jid===jid);
      if(fresh?.lastMessage?.id!==last.id) return;
      try {
        await client.sendText(jid,out.text);
        await store.update(data=>{data.contacts[jid].aiDraft=null;log(data,{jid,mode:'auto',action:'sent',detail:out.text.slice(0,160)});});
      } catch {
        await store.update(data=>{log(data,{jid,mode:'auto',action:'error',detail:'Envio sem confirmação. Confira a conversa antes de responder novamente.'});});
      }
    } catch(error) {
      await store.update(data=>{log(data,{jid,mode:claim.mode,action:'error',detail:String(error.message || error).slice(0,200)});}).catch(()=>{});
    }
  }

  async function tick() {
    if(busy || stopped) return;busy=true;
    try {
      const data=await store.read();
      const active=Object.entries(data.contacts || {}).filter(([jid,contact])=>individual.test(jid) && ['draft','auto'].includes(contact.aiMode));
      if(!active.length || !(await ai.config()).configured) return;
      const chats=new Map((await client.chats()).map(chat=>[chat.jid,chat]));
      for(const [jid,contact] of active) {
        if(stopped) return;
        const chat=chats.get(jid),last=chat?.lastMessage;
        if(!last) continue;
        if(last.fromMe) {if(contact.aiDraft) await store.update(next=>{if(next.contacts[jid]) next.contacts[jid].aiDraft=null;});continue;}
        if(last.type!=='text' || !last.text?.trim() || typeof last.id!=='string') continue;
        if(!(Number(last.timestamp)>Date.parse(contact.aiSince || ''))) continue;
        await processChat(jid,chat);
      }
    } catch {/* o próximo ciclo tenta novamente */}
    finally {busy=false;}
  }

  async function handle(req,route,url,readBody) {
    const ok=(body,status=200)=>({status,body});
    const view=async()=>{
      const data=await store.read(),settings=settingsOf(data),modes=Object.values(data.contacts || {}).map(contact=>contact.aiMode);
      return ok({enabled:settings.enabled,enabledSince:settings.enabledSince,rules:settings.rules,log:settings.log.slice(0,20),counts:{draft:modes.filter(mode=>mode==='draft').length,auto:modes.filter(mode=>mode==='auto').length},ai:(await ai.config()).configured});
    };
    if(route==='/api/assistant' && req.method==='GET') return view();
    if(route==='/api/assistant' && req.method==='PUT') {
      const input=await readBody(req);
      const rules=input.rules===undefined?undefined:core.normalizeRules(input.rules);
      if(input.enabled!==undefined && typeof input.enabled!=='boolean') throw new ApiError('Valor inválido para a chave geral.',422);
      await store.update(data=>{
        data.assistant ||= {};
        if(rules) data.assistant.rules=rules;
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
    handle,applyMode,tick,
    start() {if(timer) return;stopped=false;timer=setInterval(tick,intervalMs);timer.unref?.();},
    stop() {stopped=true;clearInterval(timer);timer=null;}
  };
}
module.exports={createAssistantService,applyMode,MODES};
