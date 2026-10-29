const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes,randomUUID,timingSafeEqual,createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {createEvolutionClient,ApiError,assertJid}=require('./lib/evolution.cjs');
const {createStore}=require('./lib/store.cjs');
const {createKnowledgeRoutes}=require('./lib/knowledge-routes.cjs');
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
  const client=createEvolutionClient(options.config,options.fetchImpl),store=createStore(dataDir),extra=createKnowledgeRoutes(dataDir,options.aiFetch);
  const requests=new Map();
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  async function sendOnce(input,send) {
    const id=textField(input.requestId,100,'Identificador do envio');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new ApiError('Identificador do envio inválido.',422);
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if(requests.has(id)) {const item=requests.get(id);if(item.hash!==hash) throw new ApiError('Identificador reutilizado com outra mensagem.',409);return item.promise;}
    // Um pedido pendente após falha/reinício nunca é reenviado automaticamente: o WhatsApp pode já tê-lo recebido.
    const promise=(async()=>{
      const previous=(await store.read()).requests[id];
      if(previous) {if(previous.hash!==hash) throw new ApiError('Identificador reutilizado.',409);if(previous.result) return previous.result;throw new ApiError('O envio anterior ficou sem confirmação. Confira a conversa antes de tentar novamente.',409);}
      await store.update(data=>{data.requests[id]={hash,at:Date.now()};const old=Object.keys(data.requests).filter(key=>data.requests[key].at<Date.now()-7*86400000);for(const key of old) delete data.requests[key];});
      const result=await send();await store.update(data=>{data.requests[id].result=result;});return result;
    })();
    requests.set(id,{hash,promise});if(requests.size>1000) requests.delete(requests.keys().next().value);
    return promise;
  }
  return http.createServer(async(req,res)=>{
    for(const [name,value] of Object.entries({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"})) res.setHeader(name,value);
    const hosts=[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`];
    if(!hosts.includes(req.headers.host)) return json(res,403,{error:'Endereço local inválido.'});
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) return json(res,403,{error:'Abra a central no endereço local.'});
    try {
      const url=new URL(req.url,`http://${req.headers.host}`),route=url.pathname;
      if(req.method==='GET' && route==='/health') return json(res,200,{service:'whatsapp-local',version:1});
      if(req.method==='GET' && ['/','/index.html','/assets/app.js','/assets/pages.js','/assets/app.css'].includes(route)) {
        const file=route.startsWith('/assets/')?route.split('/').pop():'index.html';let content=await fs.readFile(path.join(root,'public',file),'utf8');
        if(file==='index.html') content=content.replace('</head>',`<meta name="whatsapp-session" content="${token}">\n</head>`);
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});return res.end(content);
      }
      if(!route.startsWith('/api/')) return json(res,404,{error:'Endereço não encontrado.'});
      const given=req.headers['x-whatsapp-token'];if(typeof given!=='string' || !/^[a-f0-9]{64}$/.test(given) || !timingSafeEqual(Buffer.from(token),Buffer.from(given))) return json(res,403,{error:'Sessão inválida. Recarregue a página.'});
      if(req.method==='GET' && route==='/api/connection') return json(res,200,await client.connection());
      if(req.method==='POST' && route==='/api/connect') return json(res,200,await client.connect());
      if(req.method==='POST' && route==='/api/disconnect') {await client.disconnect();return json(res,200,{disconnected:true});}
      if(req.method==='GET' && route==='/api/chats') {
        const data=await store.read(),search=(url.searchParams.get('search') || '').toLocaleLowerCase('pt-BR');
        const chats=(await client.chats()).map(chat=>({...chat,...(data.contacts[chat.jid] || contactDefault())}));
        return json(res,200,chats.filter(chat=>(!search || `${chat.name} ${chat.jid} ${chat.labels.join(' ')}`.toLocaleLowerCase('pt-BR').includes(search)) && (url.searchParams.get('unread')!=='1' || chat.unread>0) && (!url.searchParams.get('status') || chat.status===url.searchParams.get('status'))).sort((a,b)=>(b.lastMessage?.timestamp || 0)-(a.lastMessage?.timestamp || 0)));
      }
      if(req.method==='GET' && route==='/api/messages') {
        const jid=assertJid(url.searchParams.get('jid')),page=Number(url.searchParams.get('page') || 1);
        if(!Number.isSafeInteger(page) || page<1 || page>100000) throw new ApiError('Página inválida.',422);
        return json(res,200,await client.messages(jid,page));
      }
      if(route==='/api/contact' && ['GET','PATCH'].includes(req.method)) {
        const jid=assertJid(url.searchParams.get('jid'));
        if(req.method==='GET') return json(res,200,(await store.read()).contacts[jid] || contactDefault());
        const input=await readBody(req);
        if(input.status!==undefined && !['open','pending','closed'].includes(input.status)) throw new ApiError('Situação inválida.',422);
        if(input.labels!==undefined && (!Array.isArray(input.labels) || input.labels.length>10 || input.labels.some(label=>typeof label!=='string' || !label.trim() || label.length>40))) throw new ApiError('Use até 10 etiquetas de até 40 caracteres.',422);
        return json(res,200,await store.update(data=>{const contact=data.contacts[jid] ||=contactDefault();if(input.status!==undefined) contact.status=input.status;if(input.labels!==undefined) contact.labels=[...new Set(input.labels.map(label=>label.trim()))];return contact;}));
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
        await store.update(data=>{const contact=data.contacts[jid] ||=contactDefault();contact.notes.unshift(note);});return json(res,201,note);
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
        if(!['image','video','audio','document'].includes(input.mediaType) || typeof input.base64!=='string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64) || !input.base64 || Buffer.byteLength(input.base64,'base64')>10*1024*1024) throw new ApiError('Anexo inválido. Envie um arquivo de até 10 MB.',422);
        textField(input.fileName,200,'Nome do arquivo');if(typeof input.mimeType!=='string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) || (input.caption!==undefined && (typeof input.caption!=='string' || input.caption.length>4000))) throw new ApiError('Tipo ou legenda do arquivo inválido.',422);
        return json(res,200,await sendOnce(input,()=>client.sendMedia(jid,input)));
      }
      if(req.method==='GET' && route==='/api/media') {
        const jid=assertJid(url.searchParams.get('jid')),id=textField(url.searchParams.get('id'),200,'Mensagem');
        const media=await client.media(jid,id);if(typeof media.base64!=='string') throw new ApiError('Mídia indisponível. Abra a mensagem no celular.');
        return json(res,200,{base64:media.base64,mimeType:media.mimetype || 'application/octet-stream',fileName:media.fileName || 'anexo'});
      }
      const handled=await extra(req,route,url,readBody);if(handled) return json(res,handled.status,handled.body);
      return json(res,404,{error:'Endereço não encontrado.'});
    } catch(error) {if(!error.status) console.error('Falha local:',error.code || error.name);return json(res,error.status || 500,{error:error.status?error.message:'Não foi possível acessar os dados locais. Consulte data/server.err.log.'});}
  });
}
if(require.main===module) {
  (async()=>{
    const config=JSON.parse(await fs.readFile(path.join(root,'data','config.json'),'utf8')),server=createWhatsAppServer({config}),url='http://127.0.0.1:8766/';
    server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`A central já pode estar aberta: ${url}`:error.message);process.exitCode=1;});
    server.listen(8766,'127.0.0.1',()=>{
      console.log(`WhatsApp Local · ${url}\nSessão preservada no Docker. Não remova os volumes.`);
      if(!process.argv.includes('--no-open')) execFile('powershell.exe',['-NoProfile','-Command',`Start-Process '${url}'`],{windowsHide:true},()=>{});
    });
  })().catch(error=>{console.error(error.code==='ENOENT'?'Abra Iniciar WhatsApp.cmd para configurar o conector.':error.message);process.exitCode=1;});
}
module.exports={createWhatsAppServer};
