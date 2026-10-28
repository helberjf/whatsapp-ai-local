const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
let createWhatsAppServer;
try { ({createWhatsAppServer}=require('../server.cjs')); } catch(error) { if(error.code!=='MODULE_NOT_FOUND') throw error; }

const jid='5511998765432@s.whatsapp.net';
const incoming={key:{id:'in-1',remoteJid:jid,fromMe:false},pushName:'Ana <teste>',message:{conversation:'Olá!'},messageTimestamp:1793200000,status:'DELIVERY_ACK'};
let upstream,server,address,token,directory,upstreamAddress,exists=false,connected=false,calls=[],failSend=false;
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>server?new Promise(resolve=>server.close(resolve)):Promise.resolve();
async function start() {
  server=createWhatsAppServer({config:{apiUrl:upstreamAddress,apiKey:'segredo-apenas-servidor',instanceName:'teste'},storeDir:directory});
  await listen(server); address=`http://127.0.0.1:${server.address().port}`;
  token=(await (await fetch(address)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)?.[1];
}
before(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-test-'));
  upstream=http.createServer(async(req,res)=>{
    const chunks=[]; for await(const c of req) chunks.push(c);
    const input=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
    calls.push({url:req.url,method:req.method,input,key:req.headers.apikey});
    res.setHeader('Content-Type','application/json');
    if(req.headers.apikey!=='segredo-apenas-servidor') {res.writeHead(401);return res.end('{}');}
    let output={};
    if(req.url==='/instance/connectionState/teste') { if(!exists) res.statusCode=404; output={instance:{instanceName:'teste',state:connected?'open':'close'}}; }
    else if(req.url==='/instance/fetchInstances?instanceName=teste') output=exists?[{name:'teste',ownerJid:connected?jid:null}]:[];
    else if(req.url==='/instance/create') { exists=true;output={instance:{instanceName:'teste'}}; }
    else if(req.url==='/instance/connect/teste') output={base64:'data:image/png;base64,cXI=',code:'qr-vivo',count:1};
    else if(req.url==='/instance/logout/teste') { connected=false; output={status:'SUCCESS'}; }
    else if(req.url==='/chat/findChats/teste') output=[{remoteJid:jid,pushName:'Ana <teste>',unreadCount:2,lastMessage:incoming},{remoteJid:'123@g.us',pushName:'Grupo'}];
    else if(req.url==='/chat/findMessages/teste') output={messages:{total:2,pages:2,currentPage:input.page,records:[{...incoming,key:{...incoming.key,id:`in-${input.page}`}}]}};
    else if(req.url==='/message/sendText/teste') { if(failSend) res.statusCode=500;output={key:{id:'out-1',remoteJid:jid,fromMe:true},message:{conversation:input.text},status:'PENDING'}; }
    else if(req.url==='/message/sendMedia/teste') output={key:{id:'media-1',remoteJid:jid,fromMe:true},status:'PENDING'};
    else if(req.url==='/chat/getBase64FromMediaMessage/teste') output={base64:'aGVsbG8=',mimetype:'text/plain',fileName:'teste.txt'};
    res.end(JSON.stringify(output));
  });
  await listen(upstream); upstreamAddress=`http://127.0.0.1:${upstream.address().port}`;
  if(createWhatsAppServer) await start();
});
after(async()=>{
  await close(server); await close(upstream);
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('whatsapp-local-test-'));
  await fs.rm(directory,{recursive:true,force:true});
});
const headers=()=>({'Content-Type':'application/json','X-WhatsApp-Token':token,Origin:address});
const request=(route,method='GET',input)=>fetch(address+route,{method,headers:headers(),...(input===undefined?{}:{body:JSON.stringify(input)})});
const api=async(route,method,input)=>{const r=await request(route,method,input);const result=await r.json();assert.equal(r.ok,true,JSON.stringify(result));return result;};

test('servidor independente disponível',()=>assert.equal(typeof createWhatsAppServer,'function'));
test('token, origem, host e arquivos privados são protegidos',async()=>{
  assert.ok(token);
  assert.equal((await fetch(address+'/api/connection')).status,403);
  assert.equal((await fetch(address+'/api/connection',{headers:{...headers(),Origin:'https://site-externo.com'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(address+'/api/connection',{headers:{...headers(),Host:'evil.local'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(hostStatus,403);
  assert.equal((await fetch(address+'/data/config.json')).status,404);
  assert.equal((await fetch(address+'/assets/../server.cjs')).status,404);
  const page=await (await fetch(address)).text(); assert.doesNotMatch(page,/segredo-apenas-servidor/);
});
test('estado ausente permite criar instância e obter QR; não cria novamente ao reconectar',async()=>{
  const state=await api('/api/connection'); assert.equal(state.state,'disconnected'); assert.equal(state.reachable,true);
  const qr=await api('/api/connect','POST',{});assert.match(qr.base64,/^data:image\/png;base64,/);
  await api('/api/connect','POST',{});
  const creates=calls.filter(c=>c.url==='/instance/create');assert.equal(creates.length,1);
  assert.equal(creates[0].input.integration,'WHATSAPP-BAILEYS');
});
test('só informa conectado quando o conector confirma e encerra QR após parear',async()=>{
  connected=true;
  const state=await api('/api/connection');assert.equal(state.state,'connected');assert.equal(state.phone,'5511998765432');
  const qr=await api('/api/connect','POST',{});assert.equal(qr.state,'connected');assert.equal(qr.base64,null);
  assert.equal(calls.filter(c=>c.url==='/instance/connect/teste').length,2);
});
test('lista conversas diretas com busca, não lidas e conteúdo normalizado',async()=>{
  const all=await api('/api/chats');assert.equal(all.length,1);assert.equal(all[0].jid,jid);assert.equal(all[0].lastMessage.text,'Olá!');
  assert.equal((await api('/api/chats?search=ana&unread=1')).length,1);
  assert.equal((await api('/api/chats?search=inexistente')).length,0);
});
test('histórico preserva paginação do contrato Evolution 2.3.7',async()=>{
  const result=await api('/api/messages?jid='+encodeURIComponent(jid)+'&page=2');
  assert.equal(result.page,2);assert.equal(result.pages,2);assert.equal(result.messages[0].id,'in-2');
  const call=calls.findLast(c=>c.url==='/chat/findMessages/teste');assert.equal(call.input.where.key.remoteJid,jid);assert.equal(call.input.page,2);
  assert.equal((await request('/api/messages?jid=..%2F..%2Fsecret')).status,422);
});
test('envia texto só por ação explícita e usa text no contrato v2.3.7; deduplica cliques',async()=>{
  const before=calls.filter(c=>c.url==='/message/sendText/teste').length;
  const input={jid,text:'Mensagem solicitada',requestId:'req-teste-001'};
  await Promise.all([api('/api/send','POST',input),api('/api/send','POST',input)]);
  const sends=calls.filter(c=>c.url==='/message/sendText/teste');assert.equal(sends.length,before+1);
  assert.equal(sends.at(-1).input.text,input.text);assert.equal(sends.at(-1).input.number,jid);assert.equal(sends.at(-1).input.textMessage,undefined);
  assert.equal((await request('/api/send','POST',{...input,text:''})).status,422);
  assert.equal((await request('/api/send','POST',{...input,jid:'123@g.us'})).status,422);
});
test('falha de envio é informada e não dispara repetição automática',async()=>{
  failSend=true;const before=calls.length;
  assert.equal((await request('/api/send','POST',{jid,text:'Falha esperada',requestId:'req-falha-001'})).status,502);
  assert.equal(calls.slice(before).filter(c=>c.url==='/message/sendText/teste').length,1);failSend=false;
});
test('anexos são validados e enviados por base64, sem buscar URLs arbitrárias',async()=>{
  await api('/api/send-media','POST',{jid,mediaType:'document',mimeType:'text/plain',fileName:'teste.txt',base64:'aGVsbG8=',requestId:'req-media-001'});
  assert.equal(calls.findLast(c=>c.url==='/message/sendMedia/teste').input.media,'aGVsbG8=');
  assert.equal((await request('/api/send-media','POST',{jid,base64:'https://malicioso.local/arquivo'})).status,422);
});
test('notas, etiquetas, status e respostas rápidas persistem após reinício',async()=>{
  await api('/api/contact?jid='+encodeURIComponent(jid),'PATCH',{status:'pending',labels:['Milhas','Cliente']});
  await api('/api/notes','POST',{jid,text:'Consultar antes de responder.'});
  await api('/api/settings','PATCH',{templates:[{name:'Boas-vindas',body:'Olá, como posso ajudar?'}]});
  await close(server);await start();
  const detail=await api('/api/contact?jid='+encodeURIComponent(jid));
  assert.equal(detail.status,'pending');assert.deepEqual(detail.labels,['Milhas','Cliente']);assert.equal(detail.notes[0].text,'Consultar antes de responder.');
  assert.equal((await api('/api/settings')).templates[0].name,'Boas-vindas');
  assert.equal((await api('/api/chats?status=pending')).length,1);
});
test('confirma leitura sem repetir chaves duplicadas do histórico sincronizado',async()=>{
  await api('/api/read','POST',{jid,keys:[incoming.key,incoming.key]});
  const call=calls.findLast(c=>c.url==='/chat/markMessageAsRead/teste');
  assert.equal(call.input.readMessages.length,1);
  assert.equal(call.input.readMessages[0].id,'in-1');
});

test('marca mensagens recebidas como lidas e desconecta apenas pela ação correspondente',async()=>{
  await api('/api/read','POST',{jid,keys:[incoming.key]});
  assert.equal(calls.findLast(c=>c.url==='/chat/markMessageAsRead/teste').input.readMessages[0].id,'in-1');
  assert.equal(calls.some(c=>c.url==='/instance/logout/teste'),false);
  await api('/api/disconnect','POST',{});assert.equal((await api('/api/connection')).state,'disconnected');
});
