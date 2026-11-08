const {ApiError,assertJid}=require('./evolution.cjs');
const {randomUUID}=require('node:crypto');
const knowledge=require('./knowledge.cjs');
const core=require('./assistant-core.cjs');
const {claimKeys,identities,inspectConversation,messageSignature,latestChat}=require('./triggers.cjs');
const {createLimiter,createBackground}=require('./concurrency.cjs');

const MODES=['off','draft','auto'];
const AUDIENCES=['classified','all','new'];
const HOURLY_CAP=6,MIN_GAP_MS=20_000,MAX_AGE=15*60_000;
// Etiqueta de quem ficou sem resposta automática dentro do prazo: nunca some em silêncio.
const NO_REPLY='Sem resposta';
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
// Várias conversas são atendidas ao mesmo tempo: até `concurrency` gerações de IA e `sendConcurrency` envios simultâneos,
// com no máximo uma tarefa por contato. A espera "humana" não segura as outras conversas.
function createAssistantService({store,client,ai,loadTexts,retrieve=async(query,limit)=>knowledge.search(await loadTexts(),query,limit),reliability=async()=>'balanced',catalogText,now=Date.now,intervalMs=8000,humanizer=null,voice=null,concurrency=4,sendConcurrency=6}) {
  // source: base de conhecimento + conversa ou só a conversa; history: quantas mensagens recentes a IA lê; tone: profissional ou natural.
  const settingsOf=data=>({enabled:false,enabledSince:null,audience:'classified',log:[],source:'base',history:14,tone:'formal',...data.assistant,rules:core.rulesOf(data.assistant)});
  let timer=null,busy=false,stopped=false,baseline=now(),generation=0,running=null;
  const aiSlots=createLimiter(Math.max(1,concurrency)),sendSlots=createLimiter(Math.max(1,sendConcurrency)),background=createBackground();
  const modeFor=(contact,settings)=>contact?.aiMode==='off'?null:settings.audience==='classified'?(['draft','auto'].includes(contact?.aiMode)?contact.aiMode:null):settings.enabled?(contact?.aiMode || 'auto'):(['draft','auto'].includes(contact?.aiMode)?contact.aiMode:null);
  const sinceOf=(contact,settings)=>settings.audience==='classified'?Math.max(baseline,Date.parse(contact?.aiSince || '') || Infinity):Math.max(baseline,Date.parse(settings.enabledSince || '') || Infinity);
  // Chegou com a central rodando e depois da ativação; "fresh" ainda está no prazo, "late" perdeu o prazo de resposta automática.
  const arrived=(last,contact,settings)=>Number.isFinite(Number(last.timestamp)) && last.timestamp<=now()+30000 && Number(last.timestamp)>sinceOf(contact,settings);
  const fresh=(last,contact,settings)=>arrived(last,contact,settings) && now()-last.timestamp<=MAX_AGE;
  const late=(last,contact,settings)=>arrived(last,contact,settings) && now()-last.timestamp>MAX_AGE;
  const enrolled=(data,ids,settings)=>!!settings.newCohort && ids.some(id=>data.assistant?.enrolled?.[id]?.cohort===settings.newCohort);
  const stillValid=(data,jid,claim,run)=>!stopped && run===generation && settingsOf(data).audience===claim.audience && settingsOf(data).enabledSince===claim.enabledSince && modeFor(data.contacts?.[jid],settingsOf(data))===claim.mode && !claim.identities.some(id=>data.contacts?.[id]?.automationPaused===true || data.contacts?.[id]?.aiMode==='off');
  const canContinue=(data,jid,last,claim,run)=>stillValid(data,jid,claim,run) && fresh(last,data.contacts?.[jid],settingsOf(data));

  const log=(data,entry)=>{data.assistant ||= {};data.assistant.log=[{at:new Date(now()).toISOString(),...entry},...(data.assistant.log || [])].slice(0,100);};
  function markUnanswered(data,jid,mode,detail) {
    data.contacts ||= {};const contact=data.contacts[jid] ||= contactBase(),labels=Array.isArray(contact.labels)?contact.labels:[];
    contact.status='pending';contact.labels=labels.includes(NO_REPLY)?labels:[...labels.slice(0,9),NO_REPLY];contact.aiDraft=null;
    log(data,{jid,mode,action:'unanswered',detail});
  }
  // A resposta automática não sai mais a tempo: a conversa vai para Pendente com "Sem resposta", e o registro explica o motivo.
  async function giveUp(jid,keys,claim,status,detail) {
    await store.update(data=>{
      for(const key of keys) if(data.replyClaims?.[key]?.owner==='assistant') data.replyClaims[key].status=status;
      markUnanswered(data,jid,claim.mode,detail);
    });
  }
  async function lateCheck(jid,last,keys,claim,run,wantsSend) {
    const data=await store.read();
    if(wantsSend && stillValid(data,jid,claim,run) && late(last,data.contacts?.[jid],settingsOf(data))) await giveUp(jid,keys,claim,'expired','A resposta automática não ficou pronta em 15 minutos. Responda manualmente.');
  }

  // Com "IA lê os áudios" ligado, áudios transcritos entram no diálogo como falas, marcados como áudio.
  async function heard(jid) {return voice && await voice.readsAudio()?await voice.transcripts(jid):null;}
  const spokenText=(message,transcripts)=>message.type==='audio' && transcripts?.has(message.id)?'[áudio transcrito] '+transcripts.get(message.id):null;
  async function conversation(jid) {
    const result=await client.messages(jid,1),transcripts=await heard(jid),{history}=settingsOf(await store.read());
    const rows=(Array.isArray(result.messages)?result.messages:[]).map(message=>{const spoken=spokenText(message,transcripts);return spoken?{...message,text:spoken}:message;}).filter(message=>(message.type==='text' || (message.type==='audio' && transcripts?.has(message.id))) && typeof message.text==='string' && message.text.trim()).sort((a,b)=>a.timestamp-b.timestamp).slice(-history);
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
  async function manualConversation(jid) {
    const result=await client.messages(jid,1),transcripts=await heard(jid),{history}=settingsOf(await store.read());
    const matching=(Array.isArray(result.messages)?result.messages:[]).filter(message=>message && (!message.jid || message.jid===jid) && (!message.key?.remoteJid || message.key.remoteJid===jid)).map(message=>{const spoken=spokenText(message,transcripts);return spoken?{...message,type:'text',text:spoken}:message;});
    const deleted=message=>message.deleted===true || message.key?.deleted===true || message.status==='DELETED' || message.type==='deleted';
    // Um registro de exclusão invalida também qualquer cópia antiga do mesmo texto.
    const deletedIds=new Set(matching.filter(deleted).map(message=>message.id));
    const unique=new Map();
    const valid=matching.filter(message=>!deletedIds.has(message.id) && message.type==='text' && message.canForward!==false
      && typeof message.text==='string' && message.text.trim() && typeof message.id==='string' && message.id
      && typeof message.fromMe==='boolean' && Number.isFinite(Number(message.timestamp))
      && (!message.key?.id || message.key.id===message.id) && (typeof message.key?.fromMe!=='boolean' || message.key.fromMe===message.fromMe));
    for(const message of valid.sort((a,b)=>Number(a.timestamp)-Number(b.timestamp))) unique.set(message.id,message);
    const recent=[...unique.values()].sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)).slice(-history),rows=[];
    let remaining=12000;
    for(let index=recent.length-1;index>=0 && remaining>0;index--) {
      const message=recent[index],text=message.text.trim().slice(-remaining);
      rows.unshift({...message,text});remaining-=text.length+1;
    }
    if(!rows.length) return null;
    const messages=[];
    for(const message of rows) {
      const role=message.fromMe?'assistant':'user';
      if(messages.at(-1)?.role===role) messages.at(-1).content+='\n'+message.text;
      else messages.push({role,content:message.text});
    }
    // Mantém os envios no histórico sem deixar que o provedor os trate como uma resposta a completar.
    if(messages[0].role==='assistant') messages.unshift({role:'user',content:'Pedido do atendente: Use as mensagens seguintes como histórico real da conversa.'});
    if(messages.at(-1).role==='assistant') messages.push({role:'user',content:'Pedido do atendente: Sugira a próxima mensagem que posso enviar para dar continuidade a esta conversa, considerando a última troca.'});
    const lastUser=rows.findLastIndex(message=>!message.fromMe);
    const question=rows.slice(Math.max(0,lastUser<0?rows.length-4:lastUser-2)).map(message=>message.text).join('\n');
    return {messages,question,lastId:rows.at(-1).id,suggestion:true};
  }
  async function generate(conv) {
    const data=await store.read(),settings=settingsOf(data),onlyConversation=settings.source==='conversation';
    // Só a conversa: nenhuma busca na base e nenhum catálogo vão para a IA.
    const sources=onlyConversation?[]:await retrieve(conv.question,4);
    const system=core.buildSystem({rules:settings.rules,catalog:onlyConversation?'':await catalogText(),sources,suggestion:conv.suggestion,reliability:await reliability(),source:settings.source,tone:settings.tone});
    const raw=await ai.complete({system,messages:conv.messages,maxTokens:500});
    const handoff=raw.includes(core.HANDOFF);
    return {text:handoff?'':raw.trim(),handoff,sources:sources.map(item=>({doc:item.docName,relevance:item.relevance,confidence:item.confidence}))};
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
      if(stopped || run!==generation || !mode || contact?.aiHandled===last.id || ids.some(id=>data.contacts?.[id]?.automationPaused===true || data.contacts?.[id]?.aiMode==='off') || keys.some(key=>data.replyClaims?.[key]) || !arrived(last,contact,current) || (current.audience==='new' && !enrolled(data,ids,current) && (!firstContact || ids.some(id=>data.assistant?.known?.[id])))) return null;
      if(!fresh(last,contact,current)) {
        if(mode!=='auto' || !current.enabled) return null;
        data.contacts ||= {};data.contacts[jid] ||= contactBase();data.contacts[jid].aiHandled=last.id;
        data.replyClaims ||= {};for(const key of keys) data.replyClaims[key]={owner:'assistant',claimedAt:new Date(now()).toISOString(),status:'expired'};
        markUnanswered(data,jid,mode,'A mensagem esperou mais de 15 minutos na fila da IA. Responda manualmente.');
        return {expired:true};
      }
      data.contacts ||= {};data.contacts[jid] ||= contactBase();
      // A reserva vem antes de qualquer geração ou envio: a mesma mensagem nunca é tratada duas vezes.
      data.contacts[jid].aiHandled=last.id;
      data.assistant ||= {};data.assistant.known ||= {};for(const id of ids) data.assistant.known[id]=true;
      if(current.audience==='new') {data.assistant.enrolled ||= {};for(const id of ids) data.assistant.enrolled[id]={cohort:current.newCohort,at:new Date(now()).toISOString()};}
      data.replyClaims ||= {};for(const key of keys) data.replyClaims[key]={owner:'assistant',claimedAt:new Date(now()).toISOString(),status:'generating'};
      return {mode,enabled:current.enabled,audience:current.audience,enabledSince:current.enabledSince,identities:ids};
    });
    if(!claim || claim.expired) return;
    const wantsSend=claim.mode==='auto' && claim.enabled;
    try {
      const conv=await conversation(jid);if(!conv || conv.lastId!==last.id) return;
      // A vaga de IA pode demorar com muitas conversas: só gera se a mensagem ainda estiver no prazo.
      const out=await aiSlots.run(async()=>canContinue(await store.read(),jid,last,claim,run)?generate(conv):null);
      if(!out || !canContinue(await store.read(),jid,last,claim,run)) {await lateCheck(jid,last,keys,claim,run,wantsSend);return;}
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
      // Tempo de gente: espera aleatória antes de começar a "digitar". Depois da espera, tudo é conferido de novo.
      const human=humanizer?await humanizer.plan(out.text):{waitMs:0,typingMs:0};
      if(human.waitMs>0) await humanizer.sleep(human.waitMs);
      const fresh=await latestChat(client,jid);
      if(messageSignature(fresh?.lastMessage)!==messageSignature(last)) return;
      const finalData=await store.read();if(!canContinue(finalData,jid,last,claim,run) || !settingsOf(finalData).enabled) {await lateCheck(jid,last,keys,claim,run,wantsSend);return;}
      try {
        const sent=await sendSlots.run(()=>voice?voice.reply(jid,out.text,{last,delay:human.typingMs}):client.sendText(jid,out.text,{delay:human.typingMs}).then(()=>({format:'text'})));
        await store.update(data=>{data.contacts[jid].aiDraft=null;for(const key of keys) if(data.replyClaims?.[key]?.owner==='assistant') data.replyClaims[key].status='sent';log(data,{jid,mode:'auto',action:'sent',...(sent.format==='audio'?{format:'audio'}:{}),detail:(sent.format==='audio'?'🎤 Em áudio: ':'')+out.text.slice(0,160)});});
      } catch {
        await store.update(data=>{for(const key of keys) if(data.replyClaims?.[key]?.owner==='assistant') data.replyClaims[key].status='uncertain';log(data,{jid,mode:'auto',action:'error',detail:'Envio sem confirmação. Confira a conversa antes de responder novamente.'});});
      }
    } catch(error) {
      // Falha antes de qualquer envio: em modo automático, a conversa não fica esperando sem ninguém saber.
      if(wantsSend) await giveUp(jid,keys,claim,'failed','A IA não conseguiu preparar a resposta. Confira a configuração da IA e responda manualmente.').catch(()=>{});
      else await store.update(data=>{log(data,{jid,mode:claim.mode,action:'error',detail:'Não foi possível preparar a resposta. Confira a configuração da IA.'});}).catch(()=>{});
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
        // Quando você (ou a IA) responde, o rascunho e a marca "Sem resposta" deixam de valer.
        if(last.fromMe) {if(contact?.aiDraft || contact?.labels?.includes(NO_REPLY)) await store.update(next=>{const item=next.contacts?.[jid];if(!item) return;item.aiDraft=null;if(Array.isArray(item.labels)) item.labels=item.labels.filter(label=>label!==NO_REPLY);});continue;}
        if(last.fromMe!==false || !['text','audio'].includes(last.type) || (last.type==='text' && !last.text?.trim()) || typeof last.id!=='string' || (last.key && (last.key.id!==last.id || last.key.remoteJid!==jid || last.key.fromMe!==false))) continue;
        if(!arrived(last,contact,settings) || background.busy(jid)) continue;
        // Fora do prazo, só interessa marcar "Sem resposta" quando a IA responderia sozinha.
        const onTime=fresh(last,contact,settings);if(!onTime && !(settings.enabled && modeFor(contact,settings)==='auto')) continue;
        if(claimKeys(identities(chat),last.id).some(key=>data.replyClaims?.[key])) continue;
        // Áudio só é respondido depois de transcrito e com a leitura de áudios ligada; até lá, o próximo ciclo confere de novo.
        if(last.type==='audio') {if(!voice || !await voice.readsAudio()) continue;if(onTime) {const job=await voice.transcriptStatus(jid,last.id);if(job?.status!=='completed' || !String(job.text || '').trim()) continue;}}
        background.dispatch(jid,()=>processChat(jid,chat,run));
      }
    } catch {/* o próximo ciclo tenta novamente */}
    finally {busy=false;}
  }

  async function handle(req,route,url,readBody) {
    const ok=(body,status=200)=>({status,body});
    const view=async()=>{
      const data=await store.read(),settings=settingsOf(data),modes=Object.values(data.contacts || {}).map(contact=>contact.aiMode);
      const unanswered=Object.values(data.contacts || {}).filter(contact=>Array.isArray(contact.labels) && contact.labels.includes(NO_REPLY)).length;
      return ok({enabled:settings.enabled,enabledSince:settings.enabledSince,audience:settings.audience,source:settings.source,history:settings.history,tone:settings.tone,rules:settings.rules,log:settings.log.slice(0,20),counts:{draft:modes.filter(mode=>mode==='draft').length,auto:modes.filter(mode=>mode==='auto').length,unanswered},load:{ai:{active:aiSlots.active,waiting:aiSlots.waiting},send:{active:sendSlots.active,waiting:sendSlots.waiting},conversations:background.size},ai:(await ai.config()).configured});
    };
    if(route==='/api/assistant' && req.method==='GET') return view();
    if(route==='/api/assistant' && req.method==='PUT') {
      const input=await readBody(req);
      const rules=input.rules===undefined?undefined:core.normalizeRules(input.rules);
      if(input.enabled!==undefined && typeof input.enabled!=='boolean') throw new ApiError('Valor inválido para a chave geral.',422);
      if(input.audience!==undefined && !AUDIENCES.includes(input.audience)) throw new ApiError('Escolha um público válido para a IA.',422);
      if(input.source!==undefined && !core.SOURCES.includes(input.source)) throw new ApiError('Escolha de onde a IA tira as respostas: base de conhecimento ou só a conversa.',422);
      if(input.history!==undefined && (!Number.isInteger(input.history) || input.history<2 || input.history>30)) throw new ApiError('A IA pode ler de 2 a 30 mensagens recentes.',422);
      if(input.tone!==undefined && !core.TONES.includes(input.tone)) throw new ApiError('Escolha o tom: profissional ou natural.',422);
      const before=settingsOf(await store.read()),nextAudience=input.audience??before.audience,broadOptIn=(input.enabled===true&&!before.enabled || nextAudience!==before.audience) && nextAudience!=='classified';
      const known=broadOptIn?await client.chats():[];
      await store.update(data=>{
        data.assistant ||= {};
        if(rules) data.assistant.rules=rules;
        if(input.audience!==undefined) data.assistant.audience=input.audience;
        for(const key of ['source','history','tone']) if(input[key]!==undefined) data.assistant[key]=input[key];
        if(nextAudience==='new' && (before.audience!=='new' || !data.assistant.newCohort)) data.assistant.newCohort=randomUUID();
        if(broadOptIn) {data.assistant.enabledSince=new Date(now()).toISOString();data.assistant.known ||= {};for(const chat of known) if(chat.lastMessage) for(const id of identities(chat)) data.assistant.known[id]=true;}
        if(input.enabled!==undefined) {if(input.enabled && !settingsOf(data).enabled) data.assistant.enabledSince=new Date(now()).toISOString();data.assistant.enabled=input.enabled;}
      });
      return view();
    }
    if(route==='/api/humanize' && humanizer) {
      if(req.method==='GET') return ok(await humanizer.settings());
      if(req.method==='PUT') return ok(await humanizer.save(await readBody(req)));
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
      const conv=await manualConversation(jid);
      if(!conv) throw new ApiError('Não há texto recente disponível nesta conversa para preparar uma sugestão.',409);
      return ok({...await generate(conv),contextLastId:conv.lastId});
    }
    return undefined;
  }
  return {
    handle,applyMode,
    // tick() espera a varredura e as conversas que ela iniciou; o servidor usa {wait:false} para não segurar os outros trabalhadores.
    tick({wait=true}={}) {if(stopped) return Promise.resolve();if(!running) running=poll().finally(()=>{running=null;});return wait?running.then(()=>background.idle()):running;},
    start({poll:pollTimer=true}={}) {if(timer) return;stopped=false;generation++;baseline=now();if(pollTimer) {timer=setInterval(()=>{void this.tick({wait:false});},intervalMs);timer.unref?.();}},
    stop() {stopped=true;generation++;clearInterval(timer);timer=null;},
    idle() {return Promise.all([running,background.idle()]).then(()=>{});},
    load:()=>({ai:{active:aiSlots.active,waiting:aiSlots.waiting},send:{active:sendSlots.active,waiting:sendSlots.waiting},conversations:background.size})
  };
}
module.exports={createAssistantService,applyMode,MODES,AUDIENCES,NO_REPLY};
