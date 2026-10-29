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
const {createTriggerService}=require('./lib/triggers.cjs');
const {createLocalAi}=require('./lib/local-ai.cjs');
const root=__dirname;
const contactDefault=()=>({status:'open',labels:[],notes:[]});
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
  const client=createEvolutionClient(options.config,options.fetchImpl),store=createStore(dataDir),rules=async()=>assistantCore.rulesOf((await store.read()).assistant);
  const extra=createKnowledgeRoutes(dataDir,options.aiFetch,options.storeDir?{knowledgeDir:options.knowledgeDir,catalogFile:options.catalogFile,rules,credentials}:{knowledgeDir:path.join(root,'base-conhecimento'),catalogFile:path.join(root,'produtos-iniciais.json'),rules,credentials});
  const assistant=createAssistantService({store,client,ai:extra.services.ai,loadTexts:extra.services.loadTexts,catalogText:extra.services.catalogText,now:options.now || Date.now,intervalMs:options.assistantIntervalMs});
  const transcriptions=createTranscriptionService({store,credentials,mediaLoader:client.media,...createAudioEngines(),...options.transcriptionEngines});
  const avatars=createAvatarService({profileLoader:client.profile,fetchImpl:options.avatarFetchImpl});
  const crm=createCrmService({store}),automation=createAutomationService({store,client});
  const triggers=createTriggerService({store,client,now:options.now || Date.now});
  const scheduler=createScheduler({store,client,now:options.now || Date.now});
  const requests=new Map();
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
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
  const server=http.createServer(async(req,res)=>{
    for(const [name,value] of Object.entries({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self' data: blob:; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"})) res.setHeader(name,value);
    const hosts=[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`];
    if(!hosts.includes(req.headers.host)) return json(res,403,{error:'Endereço local inválido.'});
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) return json(res,403,{error:'Abra a central no endereço local.'});
    try {
      const url=new URL(req.url,`http://${req.headers.host}`),route=url.pathname;
      if(req.method==='GET' && route==='/health') return json(res,200,{service:'whatsapp-local',version:1});
      if(req.method==='GET' && ['/','/index.html','/assets/app.js','/assets/pages.js','/assets/app.css','/assets/features.js','/assets/features.css','/assets/avatars.js','/assets/avatars.css','/assets/schedule.js','/assets/schedule.css','/assets/triggers.js','/assets/triggers.css','/assets/messaging.css','/assets/conversation-media.js','/assets/pdf-viewer.js'].includes(route)) {
        const file=route.startsWith('/assets/')?route.split('/').pop():'index.html';let content=await fs.readFile(path.join(root,'public',file),'utf8');
        if(file==='index.html') content=content.replace('</head>',`<meta name="whatsapp-session" content="${token}">\n</head>`);
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
      const given=req.headers['x-whatsapp-token'];if(typeof given!=='string' || !/^[a-f0-9]{64}$/.test(given) || !timingSafeEqual(Buffer.from(token),Buffer.from(given))) return json(res,403,{error:'Sessão inválida. Recarregue a página.'});
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
      if(req.method==='GET' && route==='/api/connection') return json(res,200,await client.connection());
      if(req.method==='POST' && route==='/api/connect') return json(res,200,await client.connect());
      if(req.method==='POST' && route==='/api/disconnect') {await client.disconnect();return json(res,200,{disconnected:true});}
      if(req.method==='GET' && route==='/api/chats') {
        const data=await store.read(),search=(url.searchParams.get('search') || '').toLocaleLowerCase('pt-BR');
        const chats=(await client.chats()).map(chat=>({...chat,...contactDefault(),...data.contacts[chat.jid]}));
        return json(res,200,chats.filter(chat=>(!search || `${chat.name} ${chat.jid} ${chat.labels.join(' ')}`.toLocaleLowerCase('pt-BR').includes(search)) && (url.searchParams.get('unread')!=='1' || chat.unread>0) && (!url.searchParams.get('status') || chat.status===url.searchParams.get('status'))).sort((a,b)=>(b.lastMessage?.timestamp || 0)-(a.lastMessage?.timestamp || 0)));
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
        return json(res,200,await store.update(data=>{const contact=data.contacts[jid]={...contactDefault(),...data.contacts[jid]};if(input.status!==undefined) contact.status=input.status;if(input.labels!==undefined) contact.labels=[...new Set(input.labels.map(label=>label.trim()))];if(input.aiMode!==undefined) assistant.applyMode(contact,input.aiMode);return contact;}));
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
        const input=await readBody(req),jid=assertJid(input.jid),text=textField(input.text,10000,'Mensagem');
        return json(res,200,await sendOnce(input,()=>client.sendText(jid,text)));
      }
      if(req.method==='POST' && route==='/api/send-media') {
        const input=await readBody(req),jid=assertJid(input.jid);
        if(!['image','video','audio','document'].includes(input.mediaType) || typeof input.base64!=='string' || (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length%4!==0) || !input.base64 || Buffer.byteLength(input.base64,'base64')>10*1024*1024) throw new ApiError('Anexo inválido. Envie um arquivo de até 10 MB.',422);
        textField(input.fileName,200,'Nome do arquivo');if(typeof input.mimeType!=='string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) || (input.caption!==undefined && (typeof input.caption!=='string' || input.caption.length>4000))) throw new ApiError('Tipo ou legenda do arquivo inválido.',422);
        return json(res,200,await sendOnce(input,()=>client.sendMedia(jid,input)));
      }
      if(req.method==='GET' && route==='/api/media') {
        const jid=assertJid(url.searchParams.get('jid')),id=textField(url.searchParams.get('id'),200,'Mensagem');
        const media=await client.media(jid,id);if(typeof media.base64!=='string') throw new ApiError('Mídia indisponível. Abra a mensagem no celular.');
        return json(res,200,{base64:media.base64,mimeType:media.mimetype || 'application/octet-stream',fileName:media.fileName || 'anexo'});
      }
      const handled=(await extra(req,route,url,readBody)) || (await assistant.handle(req,route,url,readBody));if(handled) return json(res,handled.status,handled.body);
      return json(res,404,{error:'Endereço não encontrado.'});
    } catch(error) {if(!error.status) console.error('Falha local:',error.code || error.name);return json(res,error.status || 500,{error:error.status?error.message:'Não foi possível acessar os dados locais. Consulte data/server.err.log.'});}
  });
  server.transcriptions=transcriptions;
  server.scheduler=scheduler;
  server.triggers=triggers;server.assistant=assistant;
  let replyTimer=null,replyTick=null;
  const pollReplies=()=>{if(replyTick) return replyTick;replyTick=(async()=>{await triggers.tick();await automation.tick();await assistant.tick();})().catch(()=>{}).finally(()=>{replyTick=null;});return replyTick;};
  server.on('listening',()=>{triggers.start({poll:false});automation.start({poll:false});assistant.start({poll:false});scheduler.start();if(!options.disableWorkers) {replyTimer=setInterval(pollReplies,5000);replyTimer.unref?.();}});
  server.cleanup=Promise.resolve();
  server.on('close',()=>{clearInterval(replyTimer);triggers.stop();automation.stop();scheduler.stop();assistant.stop();server.cleanup=Promise.all([triggers.idle(),automation.idle(),scheduler.idle(),assistant.idle(),extra.services.ai.close()]).then(()=>credentials.close());server.cleanup.catch(()=>{});});
  return server;
}
if(require.main===module) {
  (async()=>{
    const config=JSON.parse(await fs.readFile(path.join(root,'data','config.json'),'utf8')),server=createWhatsAppServer({config}),url='http://127.0.0.1:8766/';
    server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`A central já pode estar aberta: ${url}`:error.message);process.exitCode=1;});
    server.listen(8766,'127.0.0.1',()=>{
      console.log(`Whats AI · ${url}\nSessão preservada no Docker. Não remova os volumes.`);
      if(!process.argv.includes('--no-open')) execFile('powershell.exe',['-NoProfile','-Command',`Start-Process '${url}'`],{windowsHide:true},()=>{});
    });
  })().catch(error=>{console.error(error.code==='ENOENT'?'Abra Iniciar WhatsApp.cmd para configurar o conector.':error.message);process.exitCode=1;});
}
module.exports={createWhatsAppServer};
