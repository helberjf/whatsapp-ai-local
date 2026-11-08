const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes,randomUUID,timingSafeEqual,createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {createEvolutionClient,ApiError,assertJid}=require('./lib/evolution.cjs');
const {createStore}=require('./lib/store.cjs');
const {createCredentialStore}=require('./lib/credentials.cjs');
const {createTranscriptionService}=require('./lib/transcription.cjs');
const {createAudioEngines}=require('./lib/audio-engines.cjs');
const {createAvatarService}=require('./lib/avatars.cjs');
const {createCrmService}=require('./lib/crm.cjs');
const {createAutomationService}=require('./lib/automation.cjs');
const {createScheduler}=require('./lib/scheduler.cjs');
const {prepareForward}=require('./lib/forwarding.cjs');
const {createKnowledgeRoutes}=require('./lib/knowledge-routes.cjs');
const {createAssistantService}=require('./lib/assistant.cjs');
const assistantCore=require('./lib/assistant-core.cjs');
const {createHumanizer}=require('./lib/humanize.cjs');
const {createTriggerService}=require('./lib/triggers.cjs');
const {createLocalAi}=require('./lib/local-ai.cjs');
const {createSpeechEngines}=require('./lib/speech.cjs');
const {createVoiceFlow}=require('./lib/voice-flow.cjs');
const {createMessagingRoutes}=require('./lib/messaging-routes.cjs');
const {pruneState}=require('./lib/housekeeping.cjs');
const {createEvolutionEvents}=require('./lib/evolution-events.cjs');
const {createChatDelta}=require('./lib/chat-delta.cjs');
const {createTeamService}=require('./lib/team.cjs');
const {createAccountRegistry,archiveAccount,accountDir}=require('./lib/accounts.cjs');
const root=__dirname;
const {buildId}=require('./lib/build-id.cjs');
// Código com que esta central iniciou; o de disco é conferido de novo a cada 15 s para perceber atualizações.
const RUNNING_BUILD=buildId(root);
let diskBuild={id:RUNNING_BUILD,at:Date.now()};
function currentBuild() {if(Date.now()-diskBuild.at>15_000) {try {diskBuild={id:buildId(root),at:Date.now()};}catch {diskBuild.at=Date.now();}}return diskBuild.id;}
const contactDefault=()=>({status:'open',labels:[],notes:[]});
const normalizeText=text=>String(text).normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
// Arquivada: vale o registro mais recente entre o WhatsApp (extensão local) e o que foi feito pela central.
// Com "Manter conversas arquivadas" desligado no WhatsApp, uma mensagem depois de arquivar tira a conversa das arquivadas.
function archivedOf(chat,contact,remote) {
  const reported=[chat.jid,...(chat.aliasJids || [])].map(id=>remote?.get?.(id)).filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  const local=Date.parse(contact?.archivedAt || '') || 0;
  const fromWhatsApp=Boolean(reported && reported.updatedAt>=local);
  const archived=fromWhatsApp?reported.archived:contact?.archived===true;
  const since=fromWhatsApp?reported.lastMessageAt || reported.updatedAt:local;
  if(archived && remote?.meta?.unarchiveChats===true && since>0 && Number(chat.lastMessage?.timestamp || 0)>since+1000) return false;
  return archived;
}
// Arquivadas que o WhatsApp informa mas que a Evolution não lista como conversa (antigas, nunca sincronizadas,
// ou conhecidas só pelo identificador privado): entram em "Arquivadas" mesmo assim, com o nome da agenda quando houver.
async function archivedOnlyChats(list,remote,contacts,client) {
  if(!remote?.size) return [];
  const known=new Set(list.flatMap(chat=>[chat.jid,...(chat.aliasJids || [])])),missing=[];
  for(const [jid,item] of remote) {
    if(!item.archived || known.has(jid) || (item.alias && known.has(item.alias))) continue;
    known.add(jid);if(item.alias) known.add(item.alias);missing.push([jid,item]);
  }
  if(!missing.length) return [];
  const book=await client.contactsList?.().catch(()=>[]) || [],byJid=new Map();
  for(const entry of book) for(const id of [entry.jid,...(entry.aliasJids || [])]) byJid.set(id,entry);
  const result=[];
  for(const [jid,item] of missing) {
    const entry=byJid.get(jid) || byJid.get(item.alias),phoneJid=[jid,item.alias].find(id=>id?.endsWith('@s.whatsapp.net'));
    const id=entry?.jid || phoneJid || jid,phone=entry?.phone || phoneJid?.split('@')[0] || null;
    const chat={jid:id,aliasJids:[jid,item.alias].filter(value=>value && value!==id),name:entry?.name || (phone?'+'+phone:'Conversa arquivada'),nameSource:entry?.nameSource || 'number',...(phone?{phone}:{}),unread:0,lastMessage:null,archivedOnly:true};
    if(archivedOf(chat,contacts?.[id],remote)) result.push(chat);
  }
  return result;
}
const quoteId=value=>{if(value===undefined || value===null || value==='') return undefined;if(typeof value!=='string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value) || value.includes('..')) throw new ApiError('Mensagem citada inválida.',422);return value;};
function textField(value,max,label) {if(typeof value!=='string' || !value.trim() || value.length>max) throw new ApiError(`${label}: informe de 1 a ${max} caracteres.`,422);return value.trim();}
async function readBody(req) {
  if(!String(req.headers['content-type']).startsWith('application/json')) throw new ApiError('Envie os dados como JSON.',415);
  let size=0;const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>14_100_000) throw new ApiError('O anexo deve ter no máximo 10 MB.',413);chunks.push(chunk);}
  try {const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result || typeof result!=='object' || Array.isArray(result)) throw Error();return result;} catch {throw new ApiError('Dados JSON inválidos.',400);}
}
function createWhatsAppServer(options={}) {
  const token=randomBytes(32).toString('hex');
  const dataDir=options.storeDir || path.join(root,'data');
  const credentials=options.credentials || createCredentialStore(dataDir);
  const localAi=options.localAi || createLocalAi();
  // Na central real, a lista de conversas é compartilhada (2 s) e completa a cada 30 s; nos testes, cada consulta é direta.
  const production=!options.storeDir;
  const now=options.now || Date.now;
  const accounts=createAccountRegistry(dataDir,options.config,now);
  // Base de conhecimento, produtos, provedor de IA e voz são compartilhados; as regras do robô vêm da conta do pedido.
  const extra=createKnowledgeRoutes(dataDir,options.aiFetch,options.storeDir?{knowledgeDir:options.knowledgeDir,catalogFile:options.catalogFile,credentials}:{knowledgeDir:path.join(root,'base-conhecimento'),catalogFile:path.join(root,'produtos-iniciais.json'),credentials});
  const speech=options.speech || createSpeechEngines({fetchImpl:options.speechFetch});
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  // Cada conta tem conector, dados de atendimento, robôs, fila de equipe e eventos próprios: conversas, regras e envios nunca se misturam.
  function createAccountRuntime(account) {
    const config={...options.config,instanceName:account.instanceName};
    const client=createEvolutionClient({chatsCacheMs:options.chatsCacheMs ?? (production?2000:0),chatsFullRefreshMs:options.chatsFullRefreshMs ?? (production?30_000:0),...config},options.fetchImpl),store=createStore(accountDir(dataDir,account.id)),rules=async()=>assistantCore.rulesOf((await store.read()).assistant);
    // Tempo humano nas respostas automáticas: sempre na central real; nos testes só quando options.humanize for informado.
    const humanizer=options.storeDir && !options.humanize?null:createHumanizer({store,sleep:options.sleep,random:options.random});
    const transcriptions=createTranscriptionService({store,credentials,mediaLoader:client.media,...createAudioEngines(),...options.transcriptionEngines});
    // Fluxo de voz: transcrição automática, leitura dos áudios pela IA e respostas em áudio (voz do Windows ou OpenAI).
    const voice=createVoiceFlow({store,client,transcriptions,speech,credentials,now});
    const assistant=createAssistantService({humanizer,store,client,ai:extra.services.ai,retrieve:extra.services.retrieve,reliability:extra.services.reliability,catalogText:extra.services.catalogText,now,intervalMs:options.assistantIntervalMs,voice});
    const avatars=createAvatarService({profileLoader:client.profile,fetchImpl:options.avatarFetchImpl});
    const crm=createCrmService({store}),automation=createAutomationService({store,client,humanizer});
    const triggers=createTriggerService({store,client,now,humanizer});
    const scheduler=createScheduler({store,client,now});
    const team=createTeamService({store,client,ai:extra.services.ai,now});
    const requests=new Map(),chatDelta=createChatDelta();
    let events=null;
    // Uma vez por instalação: traz as conversas arquivadas no celular antes da extensão existir.
    let archiveSnapshotJob=null,archiveSnapshotRetryAt=0;
    function autoArchiveSnapshot() {
      if(archiveSnapshotJob || Date.now()<archiveSnapshotRetryAt || typeof client.archiveSnapshot!=='function') return;
      archiveSnapshotJob=client.archiveSnapshot().then(()=>client.invalidateChats(),()=>{archiveSnapshotRetryAt=Date.now()+10*60_000;}).finally(()=>{archiveSnapshotJob=null;});
    }
    async function sendOnce(input,send,prepare) {
      const id=textField(input.requestId,100,'Identificador do envio');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new ApiError('Identificador do envio inválido.',422);
      const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if(requests.has(id)) {const item=requests.get(id);if(item.hash!==hash) throw new ApiError('Identificador reutilizado com outra mensagem.',409);return item.promise;}
      // Um pedido pendente após falha/reinício nunca é reenviado automaticamente: o WhatsApp pode já tê-lo recebido.
      let claimed=false;
      const promise=(async()=>{
        const previous=(await store.read()).requests[id];
        if(previous) {claimed=true;if(previous.hash!==hash) throw new ApiError('Identificador reutilizado.',409);if(previous.result) return previous.result;throw new ApiError('O envio anterior ficou sem confirmação. Confira a conversa antes de tentar novamente.',409);}
        const prepared=prepare?await prepare():undefined;
        await store.update(data=>{data.requests[id]={hash,at:Date.now()};const old=Object.keys(data.requests).filter(key=>data.requests[key].at<Date.now()-7*86400000);for(const key of old) delete data.requests[key];});
        claimed=true;const result=await send(prepared);await store.update(data=>{data.requests[id].result=result;});return result;
      })().catch(error=>{if(!claimed && requests.get(id)?.promise===promise) requests.delete(id);throw error;});
      requests.set(id,{hash,promise});if(requests.size>1000) requests.delete(requests.keys().next().value);
      return promise;
    }
    const messaging=createMessagingRoutes({client,store,sendOnce,voice,speech,avatars,now});
    const housekeeping=()=>store.update(data=>pruneState(data,now()));
    let replyTick=null,lastPoll=0,pollAgain=false,eventTimer=null,stopped=false;
    const pollReplies=()=>{
      if(stopped) return Promise.resolve();
      if(replyTick) {pollAgain=true;return replyTick;}
      lastPoll=Date.now();
      replyTick=(async()=>{await voice.tick();await triggers.tick({wait:false});await automation.tick({wait:false});await assistant.tick({wait:false});await team.tick();})().catch(()=>{}).finally(()=>{replyTick=null;if(pollAgain) {pollAgain=false;pollReplies();}});
      return replyTick;
    };
    // Com eventos chegando, a consulta periódica vira reserva (a cada 15 s); cada mensagem nova dispara o ciclo na hora.
    const scheduledPoll=()=>{if(events?.status().connected && Date.now()-lastPoll<15_000) return;pollReplies();};
    const onEvent=name=>{
      if(!['connected','disconnected'].includes(name)) client.invalidateChats();
      clearTimeout(eventTimer);eventTimer=setTimeout(()=>{pollReplies();},400);eventTimer.unref?.();
    };
    const start=()=>{
      voice.start();team.start();triggers.start({poll:false});automation.start({poll:false});assistant.start({poll:false});scheduler.start();
      if(!options.disableWorkers) {
        if(options.events!==false && (production || options.events)) {events=createEvolutionEvents({config,onEvent,...(typeof options.events==='object'?options.events:{})});events.start();}
        housekeeping().catch(()=>{});
      }
    };
    const stop=()=>{stopped=true;clearTimeout(eventTimer);events?.stop();voice.stop();team.stop();triggers.stop();automation.stop();scheduler.stop();assistant.stop();};
    const idle=()=>Promise.all([voice.idle(),team.idle(),triggers.idle(),automation.idle(),scheduler.idle(),assistant.idle()]);
    return {account,client,store,rules,transcriptions,voice,assistant,avatars,crm,automation,triggers,scheduler,team,chatDelta,sendOnce,messaging,housekeeping,pollReplies,scheduledPoll,autoArchiveSnapshot,events:()=>events?.status() || null,start,stop,idle};
  }
  const runtimes=new Map(accounts.list().map(account=>[account.id,createAccountRuntime(account)]));
  async function accountList() {
    const rows=await Promise.all(accounts.list().filter(account=>runtimes.has(account.id)).map(async account=>({...account,connection:await runtimes.get(account.id).client.connection()})));
    return rows.map(({connection,...account})=>({...account,state:connection.state,reachable:connection.reachable,exists:connection.exists,phone:connection.phone,duplicatePhone:Boolean(connection.phone) && rows.some(other=>other.id!==account.id && other.connection.phone===connection.phone)}));
  }
  async function removeAccount(id) {
    await accounts.remove(id,()=>runtimes.get(id).client.remove());
    const runtime=runtimes.get(id);runtimes.delete(id);runtime.stop();
    // Uma espera humanizada não pode segurar a resposta; ao terminar, o robô já encontra a parada.
    await Promise.race([runtime.idle(),new Promise(resolve=>{const timer=setTimeout(resolve,3000);timer.unref?.();})]);
    await archiveAccount(dataDir,id,runtime.store,now);
  }
  const server=http.createServer(async(req,res)=>{
    for(const [name,value] of Object.entries({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self' data: blob:; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"})) res.setHeader(name,value);
    const hosts=[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`];
    if(!hosts.includes(req.headers.host)) return json(res,403,{error:'Endereço local inválido.'});
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) return json(res,403,{error:'Abra a central no endereço local.'});
    try {
      const url=new URL(req.url,`http://${req.headers.host}`),route=url.pathname;
      if(req.method==='GET' && route==='/health') {const current=currentBuild();return json(res,200,{service:'whatsapp-local',version:1,build:RUNNING_BUILD,current,stale:current!==RUNNING_BUILD,pid:process.pid});}
      if(req.method==='GET' && ['/','/index.html','/assets/app.js','/assets/pages.js','/assets/app.css','/assets/features.js','/assets/features.css','/assets/avatars.js','/assets/avatars.css','/assets/schedule.js','/assets/schedule.css','/assets/triggers.js','/assets/triggers.css','/assets/messaging.css','/assets/conversation-media.js','/assets/pdf-viewer.js','/assets/whatsapp-plus.js','/assets/whatsapp-plus.css','/assets/voice.js','/assets/team.js','/assets/accounts.js','/assets/accounts.css'].includes(route)) {
        const file=route.startsWith('/assets/')?route.split('/').pop():'index.html';let content=await fs.readFile(path.join(root,'public',file),'utf8');
        if(file==='index.html') content=content.replace('</head>',`<meta name="whatsapp-session" content="${token}">\n<meta name="whatsapp-accounts" content="${accounts.list().map(item=>item.id).join(',')}">\n</head>`);
        if(file==='index.html' && options.demo) content=content.replace('<body>','<body class="demo-mode"><div class="demo-banner" role="status">DEMO · Fictional contacts · No real WhatsApp connection</div>');
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});return res.end(content);
      }
      const pdfAsset=route.match(/^\/assets\/pdfjs\/(build|cmaps|standard_fonts|wasm|iccs)\/([A-Za-z0-9_.-]+)$/);
      if(req.method==='GET' && pdfAsset && pdfAsset[2]!=='.' && pdfAsset[2]!=='..' && (pdfAsset[1]!=='build' || ['pdf.min.mjs','pdf.worker.min.mjs'].includes(pdfAsset[2]))) {
        const vendorRoot=path.dirname(require.resolve('pdfjs-dist/package.json'));
        try {const content=await fs.readFile(path.join(vendorRoot,pdfAsset[1],pdfAsset[2]));res.writeHead(200,{'Content-Type':pdfAsset[2].endsWith('.mjs')?'text/javascript; charset=utf-8':pdfAsset[2].endsWith('.wasm')?'application/wasm':'application/octet-stream'});return res.end(content);}
        catch(error) {if(error.code==='ENOENT') return json(res,404,{error:'Arquivo não encontrado.'});throw error;}
      }
      if(!route.startsWith('/api/')) return json(res,404,{error:'Endereço não encontrado.'});
      // Integração local (ex.: radar de prospecção): token fixo opcional, liberado só para status, consulta de número, envio de texto e leitura.
      const integration=options.integrationToken ?? options.config?.integrationToken,integrationGiven=req.headers['x-integration-token'];
      if(typeof integrationGiven==='string') {
        const digest=value=>createHash('sha256').update(value).digest();
        if(typeof integration!=='string' || integration.length<32 || !timingSafeEqual(digest(integration),digest(integrationGiven))) return json(res,403,{error:'Token de integração inválido.'});
        if(![['GET','/api/connection'],['POST','/api/resolve-phone'],['POST','/api/send'],['GET','/api/messages']].some(([method,path])=>method===req.method && path===route)) return json(res,403,{error:'Rota não liberada para integração.'});
      } else {
        const given=req.headers['x-whatsapp-token'];if(typeof given!=='string' || !/^[a-f0-9]{64}$/.test(given) || !timingSafeEqual(Buffer.from(token),Buffer.from(given))) return json(res,403,{error:'Sessão inválida. Recarregue a página.'});
      }
      // A conta vem do cabeçalho X-WhatsApp-Account; sem ele, vale a primeira conta (a original).
      const chosen=req.headers['x-whatsapp-account'],runtime=runtimes.get(chosen===undefined?accounts.fallback().id:chosen);
      if(!runtime) return json(res,404,{error:'Conta não encontrada. Recarregue a página.'});
      const {account,client,store,rules,transcriptions,assistant,avatars,crm,automation,triggers,scheduler,team,chatDelta,sendOnce,messaging}=runtime;
      res.setHeader('X-WhatsApp-Account',account.id);
      if(route==='/api/accounts' && req.method==='GET') return json(res,200,await accountList());
      if(route==='/api/accounts' && req.method==='POST') {
        const created=await accounts.add((await readBody(req)).name),added=createAccountRuntime(created);
        runtimes.set(created.id,added);if(server.listening) added.start();return json(res,201,created);
      }
      const accountMatch=route.match(/^\/api\/accounts\/([a-z0-9-]{1,40})(\/disconnect)?$/);
      if(accountMatch && req.method==='PATCH' && !accountMatch[2]) {const renamed=await accounts.rename(accountMatch[1],(await readBody(req)).name);Object.assign(runtimes.get(renamed.id).account,renamed);return json(res,200,renamed);}
      if(accountMatch && req.method==='POST' && accountMatch[2]) {accounts.get(accountMatch[1]);await readBody(req);await runtimes.get(accountMatch[1]).client.disconnect();return json(res,200,{disconnected:true});}
      if(accountMatch && req.method==='DELETE' && !accountMatch[2]) {await removeAccount(accountMatch[1]);return json(res,200,{removed:true});}
      if(route==='/api/ai/local' && req.method==='GET') return json(res,200,await localAi.status({...(url.searchParams.has('model')?{model:url.searchParams.get('model')}:{}),baseUrl:url.searchParams.get('baseUrl') || '',device:url.searchParams.get('device') || 'auto'}));
      if(route==='/api/ai/local/start' && req.method==='POST') {const input=await readBody(req),state=await localAi.start(input);const config=await extra.services.ai.save({provider:'ollama',model:state.model,baseUrl:'http://127.0.0.1:11434',ollamaNumGpu:input.device==='cpu'?0:null});return json(res,200,{...state,config});}
      if(route==='/api/triggers' && ['GET','PUT'].includes(req.method)) return json(res,200,req.method==='GET'?await triggers.settings():await triggers.saveSettings(await readBody(req)));
      if(route==='/api/triggers/simulate' && req.method==='POST') return json(res,200,await triggers.simulate(await readBody(req)));
      if(route==='/api/triggers/executions' && req.method==='GET') return json(res,200,await triggers.executions());
      if(route==='/api/contact/details' && req.method==='GET') return json(res,200,await client.contactDetails(assertJid(url.searchParams.get('jid'))));
      if(route==='/api/messages/delete' && req.method==='POST') {const input=await readBody(req),jid=assertJid(input.jid),id=textField(input.messageId,200,'Mensagem');return json(res,200,await sendOnce(input,()=>client.deleteMessage(jid,id)));}
      if(route==='/api/messages/disappearing' && req.method==='POST') {const input=await readBody(req);return json(res,200,await client.disappearingMessages(assertJid(input.jid),input.expiration));}
      if(route==='/api/send-sticker' && req.method==='POST') {
        const input=await readBody(req),jid=assertJid(input.jid),mime=input.mimeType;
        if(!['image/webp','image/png','image/jpeg'].includes(mime) || typeof input.base64!=='string' || (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length%4!==0)) throw new ApiError('Envie uma figurinha WEBP, PNG ou JPG de até 1 MB.',422);
        const bytes=Buffer.from(input.base64,'base64'),valid=bytes.length>0 && bytes.length<=1024*1024 && (mime==='image/webp'?bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP':mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255 && bytes[1]===216 && bytes[2]===255);
        if(!valid || input.caption) throw new ApiError('Figurinha inválida. Envie WEBP, PNG ou JPG de até 1 MB e sem legenda.',422);
        return json(res,200,await sendOnce(input,()=>client.sendSticker(jid,input)));
      }
      if(route==='/api/scheduled-messages' && req.method==='GET') return json(res,200,await scheduler.list(url.searchParams.get('jid')));
      if(route==='/api/scheduled-messages' && req.method==='POST') return json(res,201,await scheduler.create(await readBody(req)));
      const scheduledMatch=route.match(/^\/api\/scheduled-messages\/([a-zA-Z0-9_-]{8,100})(\/cancel)?$/);
      if(scheduledMatch && req.method==='PATCH' && !scheduledMatch[2]) return json(res,200,await scheduler.update(scheduledMatch[1],await readBody(req)));
      if(scheduledMatch && req.method==='POST' && scheduledMatch[2]) {await readBody(req);return json(res,200,await scheduler.cancel(scheduledMatch[1]));}
      if(req.method==='POST' && route==='/api/contacts/sync') {await readBody(req);return json(res,200,await client.syncContacts(true));}
      if(req.method==='POST' && route==='/api/forward') {const input=await readBody(req);assertJid(input.sourceJid);assertJid(input.targetJid);return json(res,200,await sendOnce(input,send=>send(),()=>prepareForward(client,input)));}
      if(route==='/api/transcription/settings' && ['GET','PATCH'].includes(req.method)) return json(res,200,req.method==='GET'?await transcriptions.settings():await transcriptions.saveSettings(await readBody(req)));
      if(req.method==='GET' && route==='/api/transcriptions') return json(res,200,await transcriptions.list(url.searchParams.get('jid')));
      if(req.method==='POST' && route==='/api/transcriptions') return json(res,202,await transcriptions.enqueue(await readBody(req)));
      if(req.method==='GET' && route==='/api/avatar') return json(res,200,await avatars.get(url.searchParams.get('jid')));
      if(route==='/api/crm' && req.method==='GET') return json(res,200,await crm.list(await client.chats()));
      if(route==='/api/crm' && req.method==='PATCH') return json(res,200,await crm.update(url.searchParams.get('jid'),await readBody(req)));
      if(route==='/api/automation/settings' && ['GET','PATCH'].includes(req.method)) return json(res,200,req.method==='GET'?await automation.settings():await automation.saveSettings(await readBody(req)));
      if(req.method==='POST' && route==='/api/automation/simulate') return json(res,200,await automation.simulate(await readBody(req)));
      if(req.method==='GET' && route==='/api/automation/executions') return json(res,200,await automation.executions());
      if(req.method==='GET' && route==='/api/connection') return json(res,200,{...await client.connection(),accountId:account.id,accountName:account.name,events:runtime.events() || {connected:false,lastEventAt:null,lastError:null}});
      if(req.method==='POST' && route==='/api/connect') return json(res,200,await client.connect());
      if(req.method==='POST' && route==='/api/disconnect') {await client.disconnect();return json(res,200,{disconnected:true});}
      if(req.method==='POST' && route==='/api/archived/sync') {
        const result=await client.archiveSnapshot();client.invalidateChats();
        // Quantas aparecem de fato na lista: ajuda a explicar quando o WhatsApp tem mais arquivadas do que a central consegue casar.
        const [data,remote,list]=await Promise.all([store.read(),client.archivedState({maxAge:0}).catch(()=>null),client.chats()]);
        const shown=list.filter(chat=>archivedOf(chat,data.contacts?.[chat.jid],remote)).length+(await archivedOnlyChats(list,remote,data.contacts,client)).length;
        return json(res,200,{...result,shown,unarchiveChats:remote?.meta?.unarchiveChats ?? null});
      }
      if(req.method==='GET' && route==='/api/chats') {
        const data=await store.read(),search=(url.searchParams.get('search') || '').toLocaleLowerCase('pt-BR');
        const waiting=data.team?.waiting || {},archived=await client.archivedState?.().catch(()=>null);
        if((production || options.autoArchiveSnapshot) && archived?.meta?.snapshot && !archived.meta.snapshotAt) runtime.autoArchiveSnapshot();
        const listed=await client.chats(),extra=await archivedOnlyChats(listed,archived,data.contacts,client);
        const chats=[...listed,...extra].map(chat=>({...chat,...contactDefault(),...data.contacts[chat.jid],archived:archivedOf(chat,data.contacts[chat.jid],archived),...(waiting[chat.jid]?{waitingSince:waiting[chat.jid].since}:{})}));
        // delta=1: a tela recebe só as conversas alteradas desde a versão que já tem.
        if(url.searchParams.get('delta')==='1') return json(res,200,chatDelta.diff(chats.sort((a,b)=>(b.lastMessage?.timestamp || 0)-(a.lastMessage?.timestamp || 0)),url.searchParams.get('since')));
        return json(res,200,chats.filter(chat=>(!search || `${chat.name} ${chat.jid} ${chat.labels.join(' ')}`.toLocaleLowerCase('pt-BR').includes(search)) && (url.searchParams.get('unread')!=='1' || chat.unread>0) && (!url.searchParams.get('status') || chat.status===url.searchParams.get('status'))).sort((a,b)=>(b.lastMessage?.timestamp || 0)-(a.lastMessage?.timestamp || 0)));
      }
      // Contatos: agenda do WhatsApp e conversas numa lista só, com os dados do atendimento e paginação.
      if(req.method==='GET' && route==='/api/contacts') {
        const limit=Number(url.searchParams.get('limit') || 200),offset=Number(url.searchParams.get('offset') || 0),status=url.searchParams.get('status') || '',search=normalizeText(url.searchParams.get('search') || '');
        if(!Number.isInteger(limit) || limit<1 || limit>1000 || !Number.isInteger(offset) || offset<0) throw new ApiError('Paginação inválida.',422);
        if(status && !['open','pending','closed'].includes(status)) throw new ApiError('Situação inválida.',422);
        const [chatList,book,data]=await Promise.all([client.chats(),client.contactsList?.().catch(()=>[]) || [],store.read()]),known=new Set(),rows=[];
        for(const chat of chatList) {for(const id of [chat.jid,...(chat.aliasJids || [])]) known.add(id);rows.push({...chat,hasChat:true});}
        for(const contact of book) if(contact.nameSource!=='number' && ![contact.jid,...contact.aliasJids].some(id=>known.has(id))) rows.push({...contact,hasChat:false,unread:0,lastMessage:null});
        const merged=rows.map(row=>{const local=[row.jid,...(row.aliasJids || [])].map(id=>data.contacts?.[id]).find(Boolean) || {};const {notes,...rest}={...contactDefault(),...local};return {...row,...rest,notesCount:(notes || []).length};});
        const listed=merged.filter(row=>(!status || row.status===status) && (!search || normalizeText(`${row.name} ${row.phone || ''} ${row.jid} ${(row.labels || []).join(' ')}`).includes(search)));
        listed.sort((a,b)=>(b.lastMessage?.timestamp || 0)-(a.lastMessage?.timestamp || 0) || a.name.localeCompare(b.name,'pt-BR'));
        return json(res,200,{total:listed.length,withChat:listed.filter(row=>row.hasChat).length,offset,limit,contacts:listed.slice(offset,offset+limit)});
      }
      if(req.method==='GET' && route==='/api/messages') {
        const jid=assertJid(url.searchParams.get('jid')),page=Number(url.searchParams.get('page') || 1);
        if(!Number.isSafeInteger(page) || page<1 || page>100000) throw new ApiError('Página inválida.',422);
        return json(res,200,await client.messages(jid,page));
      }
      if(route==='/api/contact' && ['GET','PATCH'].includes(req.method)) {
        const jid=assertJid(url.searchParams.get('jid'));
        if(req.method==='GET') return json(res,200,{...contactDefault(),...(await store.read()).contacts[jid]});
        const input=await readBody(req);
        if(input.status!==undefined && !['open','pending','closed'].includes(input.status)) throw new ApiError('Situação inválida.',422);
        if(input.labels!==undefined && (!Array.isArray(input.labels) || input.labels.length>10 || input.labels.some(label=>typeof label!=='string' || !label.trim() || label.length>40))) throw new ApiError('Use até 10 etiquetas de até 40 caracteres.',422);
        const assignee=input.assignee===undefined?undefined:await team.assertMember(input.assignee),before=(await store.read()).contacts?.[jid];
        const saved=await store.update(data=>{const contact=data.contacts[jid]={...contactDefault(),...data.contacts[jid]};if(input.status!==undefined) contact.status=input.status;if(input.labels!==undefined) contact.labels=[...new Set(input.labels.map(label=>label.trim()))];if(input.aiMode!==undefined) assistant.applyMode(contact,input.aiMode);if(assignee!==undefined) contact.assignee=assignee;return contact;});
        // Concluir conta no painel e, se ligada, envia a pesquisa de satisfação. Falha no envio não desfaz a conclusão.
        if(input.status!==undefined) {try {const sent=await team.onStatus(jid,before?.status || 'open',input.status,saved.assignee || null);if(sent) saved.surveySent=true;}catch(error) {saved.surveyError=error.status?error.message:'A pesquisa de satisfação não foi confirmada pelo conector.';}}
        return json(res,200,saved);
      }
      if(route==='/api/settings' && ['GET','PATCH'].includes(req.method)) {
        if(req.method==='GET') return json(res,200,(await store.read()).settings);
        const input=await readBody(req);
        if(!Array.isArray(input.templates) || input.templates.length>30) throw new ApiError('Cadastre até 30 respostas rápidas.',422);
        const templates=input.templates.map(item=>({name:textField(item.name,80,'Nome'),body:textField(item.body,4000,'Resposta')}));
        return json(res,200,await store.update(data=>{data.settings.templates=templates;return data.settings;}));
      }
      if(req.method==='POST' && route==='/api/notes') {
        const input=await readBody(req),jid=assertJid(input.jid),text=textField(input.text,4000,'Nota');
        const note={id:randomUUID(),text,at:new Date().toISOString()};
        await store.update(data=>{const contact=data.contacts[jid]={...contactDefault(),...data.contacts[jid]};contact.notes.unshift(note);});return json(res,201,note);
      }
      if(req.method==='POST' && route==='/api/resolve-phone') {const input=await readBody(req);return json(res,200,await client.resolvePhone(input.phone));}
      if(req.method==='POST' && route==='/api/read') {
        const input=await readBody(req),jid=assertJid(input.jid);
        if(!Array.isArray(input.keys) || input.keys.length>100 || input.keys.some(key=>!key || typeof key.id!=='string' || key.id.length>200 || key.fromMe!==false || key.remoteJid!==jid)) throw new ApiError('Mensagens de leitura inválidas.',422);
        if(input.keys.length) await client.read(jid,input.keys);return json(res,200,{read:true});
      }
      if(req.method==='POST' && route==='/api/send') {
        const input=await readBody(req),jid=assertJid(input.jid),text=textField(input.text,10000,'Mensagem'),quotedId=quoteId(input.quotedId);
        return json(res,200,await sendOnce(input,()=>client.sendText(jid,text,quotedId?{quotedId}:{})));
      }
      if(req.method==='POST' && route==='/api/send-media') {
        const input=await readBody(req),jid=assertJid(input.jid);
        if(!['image','video','audio','document'].includes(input.mediaType) || typeof input.base64!=='string' || (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length%4!==0) || !input.base64 || Buffer.byteLength(input.base64,'base64')>10*1024*1024) throw new ApiError('Anexo inválido. Envie um arquivo de até 10 MB.',422);
        textField(input.fileName,200,'Nome do arquivo');if(typeof input.mimeType!=='string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) || (input.caption!==undefined && (typeof input.caption!=='string' || input.caption.length>4000))) throw new ApiError('Tipo ou legenda do arquivo inválido.',422);
        const quotedId=quoteId(input.quotedId);
        return json(res,200,await sendOnce(input,()=>client.sendMedia(jid,{...input,quotedId})));
      }
      if(req.method==='GET' && route==='/api/media') {
        const jid=assertJid(url.searchParams.get('jid')),id=textField(url.searchParams.get('id'),200,'Mensagem');
        const media=await client.media(jid,id);if(typeof media.base64!=='string') throw new ApiError('Mídia indisponível. Abra a mensagem no celular.');
        return json(res,200,{base64:media.base64,mimeType:media.mimetype || 'application/octet-stream',fileName:media.fileName || 'anexo'});
      }
      const handled=(await team.handle(req,route,url,readBody)) || (await messaging(req,route,url,readBody)) || (await extra(req,route,url,readBody,{rules})) || (await assistant.handle(req,route,url,readBody));if(handled) return json(res,handled.status,handled.body);
      return json(res,404,{error:'Endereço não encontrado.'});
    } catch(error) {if(!error.status) console.error('Falha local:',error.code || error.name);return json(res,error.status || 500,{error:error.status?error.message:'Não foi possível acessar os dados locais. Consulte data/server.err.log.'});}
  });
  // Atalhos dos testes e da demonstração: apontam para a conta principal (a primeira da lista).
  const main=runtimes.get(accounts.fallback().id);
  server.transcriptions=main.transcriptions;server.voice=main.voice;
  server.housekeeping=main.housekeeping;
  server.scheduler=main.scheduler;
  server.triggers=main.triggers;server.assistant=main.assistant;
  server.events=()=>main.events();
  server.invalidateChats=()=>main.client.invalidateChats();
  server.team=main.team;server.accounts=runtimes;
  let replyTimer=null,cleanTimer=null;
  server.on('listening',()=>{
    for(const runtime of runtimes.values()) runtime.start();
    if(!options.disableWorkers) {
      replyTimer=setInterval(()=>{for(const runtime of runtimes.values()) runtime.scheduledPoll();},5000);replyTimer.unref?.();
      cleanTimer=setInterval(()=>{for(const runtime of runtimes.values()) runtime.housekeeping().catch(()=>{});},30*60_000);cleanTimer.unref?.();
    }
  });
  server.cleanup=Promise.resolve();
  server.on('close',()=>{clearInterval(replyTimer);clearInterval(cleanTimer);for(const runtime of runtimes.values()) runtime.stop();server.cleanup=Promise.all([...[...runtimes.values()].map(runtime=>runtime.idle()),extra.services.embeddings.close().then(()=>extra.services.ai.close())]).then(()=>credentials.close());server.cleanup.catch(()=>{});});
  return server;
}
if(require.main===module) {
  (async()=>{
    const config=JSON.parse(await fs.readFile(path.join(root,'data','config.json'),'utf8')),server=createWhatsAppServer({config}),url='http://127.0.0.1:8766/';
    server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`A central já pode estar aberta (talvez uma versão anterior): ${url}\nUse Parar WhatsApp.cmd e depois Abrir WhatsApp.cmd.`:error.message);process.exitCode=1;});
    server.listen(8766,'127.0.0.1',()=>{
      console.log(`Whats AI · ${url}\nSessão preservada no Docker. Não remova os volumes.`);
      if(!process.argv.includes('--no-open')) execFile('powershell.exe',['-NoProfile','-Command',`Start-Process '${url}'`],{windowsHide:true},()=>{});
    });
  })().catch(error=>{console.error(error.code==='ENOENT'?'Abra Iniciar WhatsApp.cmd para configurar o conector.':error.message);process.exitCode=1;});
}
module.exports={createWhatsAppServer};
