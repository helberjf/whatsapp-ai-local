const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createExtension}=require('../infra/evolution-extensions.cjs');
const {createWhatsAppServer}=require('../server.cjs');

const jidOf=i=>'55119'+String(i).padStart(8,'0')+'@s.whatsapp.net',lid='123456789012345@lid';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('extensão guarda arquivadas do WhatsApp (celular, sincronização e central) e responde pela rota local',async()=>{
  const handlers={},saved=[];
  const extension=createExtension({load:()=>({}),save:()=>{}},{load:()=>({}),save:value=>saved.push(structuredClone(value)),delayMs:5});
  const service={instanceId:'inst',client:{ev:{on(event,handler){(handlers[event] ||= []).push(handler);}}}},controller={waMonitor:{waInstances:{teste:service}}};
  extension.observe(service);
  for(const handler of handlers['messaging-history.set']) handler({chats:[{id:jidOf(1),archived:true},{id:'120363@g.us',archived:true},{id:jidOf(2)}]});
  for(const handler of handlers['chats.update']) handler([{id:jidOf(3),archived:true},{id:jidOf(1),archived:false}]);
  for(const handler of handlers['chats.upsert']) handler([{id:lid,archived:true}]);
  await wait(30);
  assert.equal(saved.length,1,'várias mudanças seguidas viram uma gravação');
  const chats=saved[0].inst;assert.deepEqual(Object.keys(chats).sort(),[lid,jidOf(1),jidOf(3)].sort());
  assert.equal(chats[jidOf(1)].archived,false);assert.equal(chats[jidOf(3)].archived,true);assert.ok(Number.isFinite(chats[lid].updatedAt));
  let body,status;const response={status(code) {status=code;return this;},json(value) {body=value;return this;}};
  await extension.archivedHandler(controller)({params:{instanceName:'teste'},query:{}},response);
  assert.equal(status,200);assert.equal(body.archiveSync,true);assert.equal(body.chats[jidOf(3)].archived,true);
  await extension.archivedHandler(controller)({params:{instanceName:'outra'},query:{}},response);assert.equal(status,503);
});

async function serverWith(t,routes) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-archive-'));
  const fetchImpl=async(url,options={})=>{const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};const handler=Object.entries(routes).find(([part])=>route.includes(part))?.[1];if(!handler) return new Response('{}',{status:404});return new Response(JSON.stringify(typeof handler==='function'?handler(input):handler));};
  const credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,fetchImpl,credentials,disableWorkers:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};};
  return {call,server};
}
const chatRow=(jid,name,at=1793200000,alt)=>({remoteJid:jid,pushName:name,lastMessage:{key:{id:'m-'+jid,remoteJid:jid,fromMe:false,...(alt?{remoteJidAlt:alt}:{})},message:{conversation:'Oi'},messageTimestamp:at}});

test('arquivada: vale o mais recente entre o WhatsApp e a central; sem extensão, vale o que a central fez',async t=>{
  let remote={[jidOf(1)]:{archived:true,updatedAt:Date.now()-60_000},[jidOf(2)]:{archived:false,updatedAt:Date.now()-60_000}};
  const {call,server}=await serverWith(t,{'/findChats/':[chatRow(jidOf(1),'Arquivada no celular'),chatRow(jidOf(2),'Normal'),chatRow(jidOf(3),'Sem registro')],'/findContacts/':[],'/localArchived/':()=>({extensionVersion:1,archiveSync:true,chats:remote}),'/archiveChat/':input=>({chatId:input.chat,archived:true})});
  const state=async()=>Object.fromEntries((await call('/api/chats')).body.map(chat=>[chat.jid,chat.archived]));
  assert.deepEqual(await state(),{[jidOf(1)]:true,[jidOf(2)]:false,[jidOf(3)]:false});
  assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jidOf(1)),'PATCH',{archived:false})).body.archived,false);
  assert.equal((await state())[jidOf(1)],false,'desarquivar pela central vale até o WhatsApp informar algo mais novo');
  remote={...remote,[jidOf(1)]:{archived:true,updatedAt:Date.now()+1000}};server.invalidateChats();
  assert.equal((await state())[jidOf(1)],true,'arquivar de novo no celular volta a valer');
});

test('contatos: agenda e conversas juntas, sem duplicar telefone e identificador privado, com busca e páginas',async t=>{
  const {call}=await serverWith(t,{
    '/findChats/':[chatRow(lid,'Ana LID',1793200100,jidOf(1)),chatRow(jidOf(2),'Bruno',1793200000)],
    '/findContacts/':[{remoteJid:lid,pushName:'Ana Souza',lid:null},{remoteJid:jidOf(1),pushName:'Ana Souza'},{remoteJid:jidOf(4),pushName:'Carla Agenda'},{remoteJid:jidOf(5)},{remoteJid:'status@broadcast',pushName:'Status'}]
  });
  await call('/api/contact?jid='+encodeURIComponent(jidOf(4)),'PATCH',{labels:['VIP']});
  const all=(await call('/api/contacts')).body;
  assert.deepEqual({total:all.total,withChat:all.withChat},{total:3,withChat:2},'agenda sem nome e broadcast ficam de fora');
  assert.deepEqual(all.contacts.map(row=>[row.name,row.hasChat]),[['Ana Souza',true],['Bruno',true],['Carla Agenda',false]]);
  assert.equal(all.contacts[0].jid,lid);assert.equal(all.contacts[0].phone,jidOf(1).split('@')[0],'identificador privado mostra o telefone conhecido');
  assert.deepEqual(all.contacts[2].labels,['VIP']);assert.equal(all.contacts[2].notesCount,0);assert.equal(all.contacts[2].notes,undefined);
  assert.deepEqual((await call('/api/contacts?search=carla')).body.contacts.map(row=>row.name),['Carla Agenda']);
  const page=(await call('/api/contacts?limit=1&offset=1')).body;assert.deepEqual([page.total,page.contacts.length,page.contacts[0].name],[3,1,'Bruno']);
  assert.equal((await call('/api/contacts?limit=0')).status,422);assert.equal((await call('/api/contacts?status=x')).status,422);
});

// Baileys de mentira com a mesma interface usada pela extensão (consulta, decodificação de snapshot e de patches).
function fakeBaileys(rounds) {
  let call=0;
  return {
    library:{
      S_WHATSAPP_NET:'@s.whatsapp.net',newLTHashState:()=>({version:0,hash:Buffer.alloc(128),indexValueMap:{}}),
      extractSyncdPatches:async()=>({regular_low:rounds[call++]}),
      decodeSyncdSnapshot:async(name,snapshot)=>({state:{version:snapshot.version},mutationMap:Object.fromEntries(snapshot.mutations.map((item,i)=>['s'+i,item]))}),
      decodePatches:async(name,patches,state)=>({state:{version:state.version+patches.length},mutationMap:Object.fromEntries(patches.flatMap(patch=>patch.mutations).map((item,i)=>['p'+i,item]))})
    }
  };
}

test('extensão lê as arquivadas antigas do WhatsApp sem alterar a sessão e sem apagar o que é mais novo',async()=>{
  const at=Date.now(),m=(type,jid,value,timestamp)=>({index:[type,jid],syncAction:{value:{timestamp:{toNumber:()=>timestamp},...value}}});
  const rounds=[
    {snapshot:{version:5,mutations:[m('archive',jidOf(1),{archiveChatAction:{archived:true,messageRange:{lastMessageTimestamp:{toNumber:()=>1700000000}}}},at-86400_000),m('archive',jidOf(2),{archiveChatAction:{archived:true}},at-86400_000),m('archive','120363@g.us',{archiveChatAction:{archived:true}},at),m('pin_v1',jidOf(3),{pinAction:{pinned:true}},at)]},patches:[],hasMorePatches:true},
    {patches:[{mutations:[m('archive',lid,{archiveChatAction:{archived:true}},at-1000),m('setting_unarchiveChats',undefined,{unarchiveChatsSetting:{unarchiveChats:true}},at)]}],hasMorePatches:false}
  ];
  const {library}=fakeBaileys(rounds),queries=[],saved=[];
  const extension=createExtension({load:()=>({}),save:()=>{}},{load:()=>({inst:{[jidOf(2)]:{archived:false,updatedAt:at}}}),save:value=>saved.push(structuredClone(value)),delayMs:5},{loadBaileys:async()=>library});
  const writes=[],socket={ev:{on(){}},query:async node=>{queries.push(node.content[0].content[0].attrs);return {};},authState:{creds:{},keys:{get:async()=>({}),set:async()=>writes.push(1)}}};
  const service={instanceId:'inst',client:socket},controller={waMonitor:{waInstances:{teste:service}}};
  let body,status;const response={status(code) {status=code;return this;},json(value) {body=value;return this;}};
  await extension.archiveSnapshotHandler(controller)({params:{instanceName:'teste'},query:{}},response);
  assert.equal(status,200);assert.deepEqual({archived:body.archived,changed:body.changed,unarchiveChats:body.unarchiveChats},{archived:3,changed:2,unarchiveChats:true});
  assert.deepEqual(queries,[{name:'regular_low',version:'0',return_snapshot:'true'},{name:'regular_low',version:'5',return_snapshot:'false'}],'pede o snapshot e depois as mudanças seguintes');
  assert.equal(writes.length,0,'nunca grava no estado de sincronização da sessão');
  await wait(30);const chats=saved.at(-1).inst;
  assert.equal(chats[jidOf(1)].archived,true);assert.equal(chats[jidOf(1)].lastMessageAt,1700000000_000);
  assert.equal(chats[jidOf(2)].archived,false,'desarquivar registrado depois vale mais que o snapshot antigo');
  assert.equal(chats[lid].archived,true);assert.equal(chats['120363@g.us'],undefined);assert.equal(chats[jidOf(3)],undefined);
  await extension.archivedHandler(controller)({params:{instanceName:'teste'},query:{}},response);
  assert.equal(body.snapshot,true);assert.ok(body.snapshotAt>=at);assert.equal(body.unarchiveChats,true);
  await extension.archiveSnapshotHandler({waMonitor:{waInstances:{}}})({params:{instanceName:'teste'},query:{}},response);assert.equal(status,503);
  const failing=createExtension({load:()=>({}),save:()=>{}},{load:()=>({}),save:()=>{}},{loadBaileys:async()=>({...library,extractSyncdPatches:async()=>{throw new Error('failed to find key "abc" to decode mutation');}})});
  await failing.archiveSnapshotHandler(controller)({params:{instanceName:'teste'},query:{}},response);assert.equal(status,409);assert.match(body.error,/chaves/);
});

test('central busca as arquivadas antigas, avisa extensão desatualizada e aplica "mensagem nova desarquiva"',async t=>{
  const now=Date.now(),seconds=ms=>Math.floor(ms/1000);let remote={},snapshotAt=null,snapshots=0,unarchiveChats=false;
  const routes={
    '/findChats/':[chatRow(jidOf(1),'Antiga arquivada',seconds(now-3*86400_000)),chatRow(jidOf(2),'Arquivada e respondida',seconds(now-60_000))],'/findContacts/':[],
    '/localArchivedSnapshot/':()=>{snapshots++;remote={[jidOf(1)]:{archived:true,updatedAt:now-5*86400_000,lastMessageAt:now-3*86400_000},[jidOf(2)]:{archived:true,updatedAt:now-5*86400_000,lastMessageAt:now-4*86400_000}};snapshotAt=now;return {success:true,archived:2,changed:2,snapshotAt};},
    '/localArchived/':()=>({extensionVersion:2,archiveSync:true,snapshot:true,snapshotAt,unarchiveChats,chats:remote})
  };
  const {call,server}=await serverWith(t,routes);
  const state=async()=>Object.fromEntries((await call('/api/chats')).body.map(chat=>[chat.jid,chat.archived]));
  assert.deepEqual(await state(),{[jidOf(1)]:false,[jidOf(2)]:false});assert.equal(snapshots,0,'nos testes a leitura automática fica desligada');
  const result=await call('/api/archived/sync','POST',{});assert.equal(result.status,200);assert.equal(result.body.archived,2);
  assert.deepEqual(await state(),{[jidOf(1)]:true,[jidOf(2)]:true},'"Manter arquivadas" ligado: ficam arquivadas');
  unarchiveChats=true;server.invalidateChats();
  assert.deepEqual(await state(),{[jidOf(1)]:true,[jidOf(2)]:false},'com mensagem depois de arquivar, sai das arquivadas como no celular');
  delete routes['/localArchivedSnapshot/'];const old=await call('/api/archived/sync','POST',{});assert.equal(old.status,409);assert.match(old.body.error,/Abrir WhatsApp/);
});

test('central sobe a leitura automática uma vez quando a extensão ainda não leu as arquivadas',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-archive-auto-'));let snapshotAt=null,snapshots=0;
  const fetchImpl=async url=>{const route=new URL(url).pathname;let body={};
    if(route.includes('/localArchivedSnapshot/')) {snapshots++;snapshotAt=Date.now();body={success:true,archived:0,changed:0,snapshotAt};}
    else if(route.includes('/localArchived/')) body={extensionVersion:2,archiveSync:true,snapshot:true,snapshotAt,chats:{}};
    else if(route.includes('/findChats/')) body=[chatRow(jidOf(1),'Ana')];else if(route.includes('/findContacts/')) body=[];
    return new Response(JSON.stringify(body),{status:200});};
  const credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,fetchImpl,credentials,disableWorkers:true,autoArchiveSnapshot:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const chats=()=>fetch(base+'/api/chats',{headers:{'X-WhatsApp-Token':token}}).then(response=>response.json());
  await Promise.all([chats(),chats(),chats()]);await wait(30);await chats();await chats();
  assert.equal(snapshots,1,'uma leitura só, mesmo com várias telas abertas');
});

test('health informa a versão do código em execução para o iniciador reiniciar uma central antiga',async t=>{
  const {buildId}=require('../lib/build-id.cjs');
  const {server}=await serverWith(t,{'/findChats/':[],'/findContacts/':[]});
  const base='http://127.0.0.1:'+server.address().port,health=await (await fetch(base+'/health')).json();
  assert.equal(health.service,'whatsapp-local');assert.equal(health.build,buildId());assert.equal(health.stale,false);assert.equal(health.pid,process.pid);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-build-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'lib'));await fs.writeFile(path.join(dir,'server.cjs'),'a');const first=buildId(dir);
  await fs.writeFile(path.join(dir,'lib','x.cjs'),'b');assert.notEqual(buildId(dir),first,'qualquer arquivo novo da central muda a versão');
});

test('arquivada por identificador privado (@lid) também vale para o telefone da conversa',async()=>{
  const rounds=[{snapshot:{version:1,mutations:[{index:['archive',lid],syncAction:{value:{timestamp:{toNumber:()=>Date.now()-1000},archiveChatAction:{archived:true}}}}]},patches:[],hasMorePatches:false}];
  const {library}=fakeBaileys(rounds),saved=[],handlers={};
  const extension=createExtension({load:()=>({}),save:()=>{}},{load:()=>({}),save:value=>saved.push(structuredClone(value)),delayMs:5},{loadBaileys:async()=>library});
  const socket={ev:{on(event,handler){(handlers[event] ||= []).push(handler);}},query:async()=>({}),authState:{creds:{},keys:{get:async()=>({})}},signalRepository:{lidMapping:{getPNForLID:async jid=>jid===lid?jidOf(7).replace('@',':0@'):jid==='999999999999999@lid'?jidOf(8).replace('@',':3@'):null}}};
  const service={instanceId:'inst',client:socket};
  const result=await extension.archiveSnapshot(service);
  assert.deepEqual({archived:result.archived,lid:result.lid,linked:result.linked},{archived:1,lid:1,linked:1});
  extension.observe(service);for(const handler of handlers['chats.update']) handler([{id:'999999999999999@lid',archived:true}]);
  await wait(40);const chats=saved.at(-1).inst;
  assert.equal(chats[lid].archived,true);assert.equal(chats[jidOf(7)].archived,true,'telefone ganha o mesmo estado, sem o :dispositivo');
  assert.equal(chats[jidOf(8)].archived,true,'atualização ao vivo por @lid também chega ao telefone');
});
