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
