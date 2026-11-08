const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createEvolutionClient}=require('../lib/evolution.cjs');
const {createEvolutionEvents}=require('../lib/evolution-events.cjs');
const {createChatDelta}=require('../lib/chat-delta.cjs');
const {createStore}=require('../lib/store.cjs');
const {createTranscriptionService}=require('../lib/transcription.cjs');
const {createAudioEngines}=require('../lib/audio-engines.cjs');
const {createWhatsAppServer}=require('../server.cjs');

const jidOf=i=>'55119'+String(i).padStart(8,'0')+'@s.whatsapp.net';
const row=(i,text='Olá',at=1793200000)=>({remoteJid:jidOf(i),pushName:'Cliente '+i,unreadCount:0,lastMessage:{key:{id:'m'+i+'-'+at,remoteJid:jidOf(i),fromMe:false},message:{conversation:text},messageTimestamp:at}});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function connector(rows) {
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};calls.push({route,input});
    if(route.includes('/findChats/')) {const filter=input.where?.remoteJid;await wait(5);return new Response(JSON.stringify(filter?rows().filter(item=>item.remoteJid===filter):rows()));}
    if(route.includes('/findContacts/')) return new Response('[]');
    if(route.includes('/sendText/')) return new Response(JSON.stringify({key:{id:'out',remoteJid:input.number,fromMe:true},message:{conversation:input.text}}));
    if(route.includes('/connectionState/')) return new Response(JSON.stringify({instance:{state:'open'}}));
    if(route.includes('/fetchInstances')) return new Response(JSON.stringify([{name:'teste',ownerJid:'5511000000000@s.whatsapp.net'}]));
    return new Response('{}');
  };
  return {calls,fetchImpl,chatCalls:()=>calls.filter(call=>call.route.includes('/findChats/'))};
}
const config={apiUrl:'http://127.0.0.1:8767',apiKey:'chave-local',instanceName:'teste'};

test('lista compartilhada: cache curto, uma consulta para chamadas simultâneas, recentes no intervalo e completa no prazo',async()=>{
  let rows=[row(1),row(2)];const fake=connector(()=>rows);
  // Janelas largas: com a suíte inteira em paralelo, poucos milissegundos de atraso não podem mudar o resultado.
  const client=createEvolutionClient({...config,chatsCacheMs:400,chatsFullRefreshMs:2000},fake.fetchImpl);
  const [first,second]=await Promise.all([client.chats(),client.chats()]);
  assert.equal(fake.chatCalls().length,1,'chamadas ao mesmo tempo dividem uma consulta');assert.deepEqual(fake.chatCalls()[0].input,{});
  assert.deepEqual(first.map(chat=>chat.jid),[jidOf(1),jidOf(2)]);assert.notEqual(first,second);
  await client.chats();assert.equal(fake.chatCalls().length,1,'dentro do cache não consulta de novo');
  rows=[row(3,'Nova conversa',1793200500),...rows];await wait(450);
  const recent=await client.chats(),query=fake.chatCalls().at(-1).input;
  assert.ok(query.where.messageTimestamp.gte && query.where.messageTimestamp.lte,'consulta só as conversas recentes');
  assert.ok(Date.parse(query.where.messageTimestamp.lte)>Date.now() && Date.parse(query.where.messageTimestamp.gte)<Date.now()-9*60_000);
  assert.deepEqual(recent.map(chat=>chat.jid),[jidOf(3),jidOf(1),jidOf(2)]);
  rows=[row(1)];await wait(2100);
  assert.deepEqual((await client.chats()).map(chat=>chat.jid),[jidOf(1)],'a listagem completa remove o que saiu');assert.deepEqual(fake.chatCalls().at(-1).input,{});
});

test('conversa única antes de enviar, e envio invalida a lista em cache',async()=>{
  const rows=[row(1),row(2,'Primeira')];const fake=connector(()=>rows);
  const client=createEvolutionClient({...config,chatsCacheMs:60_000,chatsFullRefreshMs:600_000},fake.fetchImpl);
  await client.chats();rows[1]=row(2,'Segunda',1793200900);
  const latest=await client.chat(jidOf(2));
  assert.deepEqual(fake.chatCalls().at(-1).input,{where:{remoteJid:jidOf(2)}});assert.equal(latest.lastMessage.text,'Segunda');
  assert.equal((await client.chats())[0].lastMessage.text,'Segunda','a conversa consultada atualiza a lista sem nova consulta');assert.equal(fake.chatCalls().length,2);
  assert.equal(await client.chat(jidOf(9)),null);
  await client.sendText(jidOf(1),'Oi');await client.chats();assert.equal(fake.chatCalls().length,4,'depois do envio a lista é consultada de novo');
  const direct=createEvolutionClient(config,fake.fetchImpl),before=fake.chatCalls().length;await direct.chats();await direct.chats();
  assert.equal(fake.chatCalls().length-before,2,'sem cache configurado o comportamento é o de antes');
});

class FakeSocket {
  static instances=[];
  constructor(url) {this.url=url;this.sent=[];FakeSocket.instances.push(this);}
  send(data) {this.sent.push(data);}
  close() {this.closed=true;queueMicrotask(()=>this.onclose?.());}
  receive(data) {this.onmessage?.({data});}
}

test('eventos: protocolo Socket.IO, ping, filtro de instância e reconexão',async()=>{
  FakeSocket.instances=[];const events=[];
  const listener=createEvolutionEvents({config,WebSocketImpl:FakeSocket,retryMs:[10],onEvent:(name,data)=>events.push([name,data])});
  listener.start();const socket=FakeSocket.instances[0],url=new URL(socket.url);
  assert.equal(url.protocol,'ws:');assert.equal(url.host,'127.0.0.1:8767');assert.equal(url.pathname,'/socket.io/');
  assert.deepEqual(Object.fromEntries(url.searchParams),{EIO:'4',transport:'websocket',apikey:'chave-local'});
  socket.receive('0{"sid":"a","pingInterval":25000,"pingTimeout":20000}');assert.deepEqual(socket.sent,['40']);
  socket.receive('40{"sid":"b"}');assert.equal(listener.status().connected,true);
  socket.receive('2');assert.equal(socket.sent.at(-1),'3');
  socket.receive('42["messages.upsert",{"instance":"teste","data":{"key":{"id":"x"}}}]');
  socket.receive('42["messages.upsert",{"instance":"outra","data":{}}]');socket.receive('42["presence.update",{"instance":"teste"}]');socket.receive('42não é json');
  assert.deepEqual(events,[['connected',null],['messages.upsert',{key:{id:'x'}}]]);
  socket.receive('44{"message":"Invalid namespace"}');await wait(30);
  assert.equal(listener.status().connected,false);assert.match(listener.status().lastError,/recusou/);
  assert.equal(events.at(-1)[0],'disconnected');assert.equal(FakeSocket.instances.length,2,'reconecta sozinho');
  listener.stop();await wait(30);assert.equal(FakeSocket.instances.length,2,'parado não reconecta');
});

test('eventos: anexo binário e quadro inesperado não derrubam a central; evento binário também conta',async()=>{
  FakeSocket.instances=[];const events=[];
  const listener=createEvolutionEvents({config,WebSocketImpl:FakeSocket,retryMs:[10],onEvent:(name,data)=>events.push([name,data])});
  listener.start();const socket=FakeSocket.instances[0];
  assert.equal(socket.binaryType,'arraybuffer','quadros binários chegam como ArrayBuffer, não como Blob');
  socket.receive('0{"sid":"a","pingInterval":25000,"pingTimeout":20000}');socket.receive('40{"sid":"b"}');
  // Evolution manda miniaturas como anexo binário: texto "451-[...]" seguido do quadro binário.
  socket.receive('451-["messages.upsert",{"instance":"teste","data":{"key":{"id":"y"},"thumb":{"_placeholder":true,"num":0}}}]');
  for(const frame of [new Blob([new Uint8Array([255,216,255])]),new Uint8Array([1,2,3]).buffer,new Uint8Array([4,5]),{inesperado:true},null]) assert.doesNotThrow(()=>socket.receive(frame));
  socket.receive('42["messages.upsert",{"instance":"teste","data":{"key":{"id":"z"}}}]');
  assert.deepEqual(events.map(([name,data])=>[name,data?.key?.id ?? null]),[['connected',null],['messages.upsert','y'],['messages.upsert','z']]);
  assert.equal(listener.status().connected,true,'a conexão segue aberta');
  listener.stop();
});

test('servidor: evento novo invalida a lista e dispara o ciclo na hora; /api/connection informa o tempo real',async t=>{
  FakeSocket.instances=[];
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-events-'));
  await createStore(dir).update(data=>{data.triggers={settings:{enabled:true,enabledSince:new Date().toISOString(),cooldownSeconds:60,rules:[]}};});
  const fake=connector(()=>[row(1)]),credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config,storeDir:dir,fetchImpl:fake.fetchImpl,credentials,chatsCacheMs:600_000,chatsFullRefreshMs:600_000,events:{WebSocketImpl:FakeSocket,retryMs:[10_000]}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});});
  const socket=FakeSocket.instances[0];socket.receive('0{}');socket.receive('40{}');
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  assert.equal((await (await fetch(base+'/api/connection',{headers:{'X-WhatsApp-Token':token}})).json()).events.connected,true);
  await wait(450);const before=fake.chatCalls().length;
  socket.receive('42["messages.upsert",{"instance":"teste","data":{"key":{"id":"novo"}}}]');
  await wait(600);
  const after=fake.chatCalls().slice(before);
  assert.ok(after.some(call=>call.input.where?.messageTimestamp),'o evento leva a uma consulta das conversas recentes');
});

test('tela recebe só o que mudou: versão completa, sem mudanças, alteradas e removidas',()=>{
  const delta=createChatDelta(),a={jid:'a',lastMessage:{timestamp:1}},b={jid:'b',lastMessage:{timestamp:2}};
  const first=delta.diff([b,a],null);assert.equal(first.full,true);assert.deepEqual(first.chats.map(chat=>chat.jid),['b','a']);
  const same=delta.diff([b,a],first.version);assert.deepEqual({full:same.full,changed:same.changed,removed:same.removed,version:same.version},{full:false,changed:[],removed:[],version:first.version});
  const changed=delta.diff([{...a,unread:3},b],first.version);assert.deepEqual(changed.changed.map(chat=>chat.jid),['a']);assert.notEqual(changed.version,first.version);
  const removed=delta.diff([b],changed.version);assert.deepEqual(removed.removed,['a']);assert.deepEqual(removed.changed,[]);
  assert.equal(delta.diff([b],'versao-desconhecida').full,true);
});

test('transcrição: vários áudios ao mesmo tempo, limite de fila configurável e faster-whisper',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-transcribe-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let active=0,peak=0;const engines=[],release=[];
  const service=createTranscriptionService({store:createStore(dir),mediaLoader:async()=>({base64:Buffer.from('audio').toString('base64'),mimetype:'audio/ogg'}),whisperEngine:async({settings})=>{engines.push(settings.engine);active++;peak=Math.max(peak,active);await new Promise(resolve=>release.push(resolve));active--;return {text:'ok'};}});
  await assert.rejects(service.saveSettings({concurrency:9}),{status:422});await assert.rejects(service.saveSettings({maxQueue:5}),{status:422});await assert.rejects(service.saveSettings({engine:'outro'}),{status:422});
  const saved=await service.saveSettings({concurrency:2,maxQueue:10,engine:'faster-whisper'});
  assert.deepEqual({engine:saved.engine,concurrency:saved.concurrency,maxQueue:saved.maxQueue},{engine:'faster-whisper',concurrency:2,maxQueue:10});
  for(let i=0;i<10;i++) await service.enqueue({jid:jidOf(1),messageId:'audio-'+i});
  await assert.rejects(service.enqueue({jid:jidOf(1),messageId:'audio-extra'}),{status:429,message:/10 áudios/});
  await wait(30);assert.equal(active,2,'dois ao mesmo tempo');assert.equal((await service.settings()).running,2);
  while((await service.list(jidOf(1))).some(job=>job.status!=='completed')) {release.splice(0).forEach(done=>done());await wait(5);}
  await service.idle();assert.equal(peak,2);assert.ok(engines.every(engine=>engine==='faster-whisper'));
  assert.equal((await service.list(jidOf(1)))[0].model,'faster-whisper:base');
  const calls=[];const audio=createAudioEngines({temporaryRoot:dir,runFile:async(file,args)=>{calls.push(args);if(args.includes('-nostdin')) await fs.writeFile(args.at(-1),Buffer.alloc(200));else await fs.writeFile(args[args.indexOf('--output')+1],JSON.stringify({error:'missing_faster_whisper'}));}});
  await assert.rejects(audio.whisperEngine({bytes:Buffer.from('x'),settings:{whisperModel:'base',language:'pt',engine:'faster-whisper'}}),/faster-whisper/);
  assert.equal(calls[1][calls[1].indexOf('--engine')+1],'faster-whisper');
});
