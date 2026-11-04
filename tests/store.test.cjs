const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createStore}=require('../lib/store.cjs');
const {pruneState}=require('../lib/housekeeping.cjs');

async function temp(t) {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const rows=(dir,sql,...args)=>{const db=new DatabaseSync(path.join(dir,'central.sqlite'));try {return db.prepare(sql).all(...args);}finally {db.close();}};

test('migra o atendimento.json uma única vez e guarda o original como cópia',async t=>{
  const dir=await temp(t),legacy={contacts:{'5511999990000@s.whatsapp.net':{status:'pending',labels:['VIP'],notes:[]}},requests:{},settings:{templates:[]},triggers:{settings:{enabled:true}}};
  await fs.writeFile(path.join(dir,'atendimento.json'),JSON.stringify(legacy));
  const store=createStore(dir);
  assert.deepEqual(JSON.parse(JSON.stringify(await store.read())),legacy);
  await assert.rejects(fs.access(path.join(dir,'atendimento.json')));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'atendimento.json.migrado'),'utf8')),legacy);
  await fs.writeFile(path.join(dir,'atendimento.json'),JSON.stringify({contacts:{},settings:{templates:[{name:'x',body:'y'}]}}));
  assert.equal((await createStore(dir).read()).contacts['5511999990000@s.whatsapp.net'].labels[0],'VIP','um JSON novo não substitui o banco já migrado');
});

test('leituras são cópias independentes e uma atualização com erro não grava nada',async t=>{
  const dir=await temp(t),store=createStore(dir);
  await store.update(data=>{data.contacts.a={status:'open',labels:[]};data.assistant={log:[]};});
  const snapshot=await store.read();snapshot.contacts.a.status='closed';snapshot.assistant.log.push('x');delete snapshot.contacts.a;
  assert.equal((await store.read()).contacts.a.status,'open');assert.deepEqual((await store.read()).assistant.log,[]);
  await assert.rejects(store.update(data=>{data.contacts.a.status='closed';data.assistant.log.push('y');throw new Error('falha no meio');}),/falha no meio/);
  assert.equal((await store.read()).contacts.a.status,'open');assert.deepEqual((await createStore(dir).read()).assistant.log,[]);
  const before=(await store.read()).contacts;await store.update(data=>{data.contacts.b={status:'open'};});
  assert.equal(Object.hasOwn(before,'b'),false,'uma leitura anterior continua no seu instante');
});

test('grava só o item alterado, remove chaves e itens e reabre igual',async t=>{
  const dir=await temp(t),store=createStore(dir);
  await store.update(data=>{for(let i=0;i<50;i++) data.contacts['c'+i]={status:'open',n:i};data.replyClaims ||= {};data.replyClaims.k1={owner:'assistant',claimedAt:'2026-11-01T00:00:00.000Z'};data.extra={value:1};});
  const before=new Map(rows(dir,"SELECT key, rowid FROM entries WHERE store='atendimento' AND collection='contacts' ORDER BY rowid").map(row=>[row.key,row.rowid]));
  const result=await store.update(data=>{data.contacts.c7.status='closed';Object.keys(data.contacts).length;return data.contacts;});
  assert.equal(result.c7.status,'closed');assert.equal(Object.getPrototypeOf(result),Object.prototype);
  const after=rows(dir,"SELECT key, rowid, value FROM entries WHERE store='atendimento' AND collection='contacts' ORDER BY rowid");
  assert.equal(after.length,50);assert.deepEqual(after.map(row=>row.key),[...before.keys()],'a ordem e as linhas são preservadas');
  assert.equal(JSON.parse(after.find(row=>row.key==='c7').value).status,'closed');
  await store.update(data=>{delete data.contacts.c3;delete data.extra;data.replyClaims.k2={owner:'triggers',claimedAt:'2026-11-02T00:00:00.000Z'};data.flag=undefined;data.list=[1,2];});
  await store.update(data=>{data.requests={r1:{hash:'h',at:1}};});
  const reopened=await createStore(dir).read();
  assert.equal(Object.keys(reopened.contacts).length,49);assert.equal(reopened.contacts.c3,undefined);assert.equal(Object.hasOwn(reopened,'extra'),false);assert.equal(Object.hasOwn(reopened,'flag'),false);
  assert.deepEqual(Object.keys(reopened.replyClaims),['k1','k2']);assert.deepEqual(reopened.list,[1,2]);assert.deepEqual(reopened.requests,{r1:{hash:'h',at:1}});
  assert.equal(JSON.stringify(reopened.contacts.c7),'{"status":"closed","n":7}');
  assert.equal(rows(dir,"SELECT COUNT(*) AS n FROM entries WHERE store='atendimento' AND collection='requests'")[0].n,1);
  assert.equal('c1' in reopened.contacts,true);assert.equal('c3' in reopened.contacts,false);assert.equal(Object.values(reopened.contacts).length,49);
  assert.deepEqual({...(await store.read()).replyClaims}.k2,{owner:'triggers',claimedAt:'2026-11-02T00:00:00.000Z'});
});

test('atualizações concorrentes são aplicadas em ordem, e os outros arquivos continuam em JSON',async t=>{
  const dir=await temp(t),store=createStore(dir);
  await Promise.all(Array.from({length:40},(_,i)=>store.update(data=>{data.counter=(data.counter || 0)+1;data.contacts['c'+i]={i};})));
  assert.equal((await store.read()).counter,40);assert.equal(Object.keys((await createStore(dir).read()).contacts).length,40);
  const ai=createStore(dir,{file:'ai.json',initial:{provider:'openai'}});await ai.update(data=>{data.model='m';});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'ai.json'),'utf8')),{provider:'openai',model:'m'});
});

test('limpeza remove reservas antigas e mantém as recentes e as sem data',async t=>{
  const now=Date.parse('2026-11-04T12:00:00.000Z'),day=86_400_000,dir=await temp(t),store=createStore(dir);
  await store.update(data=>{
    data.replyClaims={old:{claimedAt:new Date(now-4*day).toISOString()},recent:{claimedAt:new Date(now-day).toISOString()},nodate:{owner:'x'}};
    data.triggers={processed:{old:{at:now-5*day},recent:{at:now-60_000}},known:{a:true}};
    data.automation={processed:{old:{at:now-10*day,executionId:'e'}}};
    data.requests.old={hash:'h',at:now-8*day};data.requests.recent={hash:'h',at:now-6*day};
  });
  assert.deepEqual(await store.update(data=>pruneState(data,now)),{replyClaims:1,processed:2,requests:1});
  const data=await createStore(dir).read();
  assert.deepEqual(Object.keys(data.replyClaims).sort(),['nodate','recent']);assert.deepEqual(Object.keys(data.triggers.processed),['recent']);
  assert.deepEqual(data.triggers.known,{a:true},'contatos conhecidos não são apagados');assert.deepEqual(data.automation.processed,{});
  assert.deepEqual(Object.keys(data.requests),['recent']);
});

test('instalação antiga: atendimento.sqlite, JSONs e pastas passam para o central.sqlite e ficam como cópia',async t=>{
  const {createWhatsAppServer}=require('../server.cjs');
  const dir=await temp(t),docId='11111111-1111-4111-8111-111111111111',imageId='22222222-2222-4222-8222-222222222222';
  // Formato do commit anterior: atendimento.sqlite com tabelas sem a coluna de store.
  const old=new DatabaseSync(path.join(dir,'atendimento.sqlite'));
  old.exec("CREATE TABLE documents (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE entries (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, key)); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.prepare("INSERT INTO documents VALUES ('contacts','collection','{}'),('requests','collection','{}'),('settings','value',?)").run(JSON.stringify({templates:[{name:'Oi',body:'Olá!'}]}));
  old.prepare("INSERT INTO entries VALUES ('contacts','5511999990000@s.whatsapp.net',?)").run(JSON.stringify({status:'pending',labels:['Antigo'],notes:[]}));
  old.prepare("INSERT INTO meta VALUES ('initialized','2026-11-01')").run();old.close();
  await fs.writeFile(path.join(dir,'atendimento.json.migrado'),'{}');
  await fs.writeFile(path.join(dir,'knowledge.json'),JSON.stringify({documents:[{id:docId,name:'Garantia.txt',type:'txt',size:20,chars:20,source:'upload',hash:'h',createdAt:'2026-11-01T00:00:00.000Z'}],skipped:[]}));
  await fs.mkdir(path.join(dir,'knowledge'));await fs.writeFile(path.join(dir,'knowledge',docId+'.txt'),'Garantia de 12 meses');
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(16,7)]);
  await fs.writeFile(path.join(dir,'produtos.json'),JSON.stringify({products:[{id:'p1',name:'Fone',kind:'produto',category:'Áudio',active:true,images:[{id:imageId,mime:'image/png'}]}],seeded:true}));
  await fs.mkdir(path.join(dir,'product-images'));await fs.writeFile(path.join(dir,'product-images',imageId),png);
  await fs.mkdir(path.join(dir,'embeddings'));await fs.writeFile(path.join(dir,'embeddings',docId+'.json'),JSON.stringify({signature:'s',hash:'h',size:1,vectors:''}));
  const credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,credentials,disableWorkers:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;});
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async route=>{const response=await fetch(base+route,{headers:{'X-WhatsApp-Token':token}});return {status:response.status,body:await response.json()};};
  assert.deepEqual((await call('/api/contact?jid='+encodeURIComponent('5511999990000@s.whatsapp.net'))).body.labels,['Antigo']);
  assert.deepEqual((await call('/api/settings')).body.templates,[{name:'Oi',body:'Olá!'}]);
  assert.equal((await call('/api/kb/doc?id='+docId)).body.text,'Garantia de 12 meses');
  assert.equal((await call('/api/product-image?id='+imageId)).body.base64,png.toString('base64'));
  await server.knowledgeReady?.();
  const files=(await fs.readdir(dir)).sort();
  for(const name of ['central.sqlite','atendimento.sqlite.migrado','knowledge.json.migrado','produtos.json.migrado','knowledge.migrado','product-images.migrado']) assert.ok(files.includes(name),name+' '+files.join(','));
  for(const name of ['atendimento.sqlite','knowledge.json','produtos.json','knowledge','product-images']) assert.equal(files.includes(name),false,name);
  const stores=rows(dir,'SELECT DISTINCT store FROM documents ORDER BY store').map(row=>row.store);
  assert.deepEqual(stores,['atendimento','knowledge','produtos']);
  assert.deepEqual(rows(dir,'SELECT DISTINCT store FROM blobs ORDER BY store').map(row=>row.store).filter(name=>name!=='embeddings'),['knowledge-texts','product-images']);
});
