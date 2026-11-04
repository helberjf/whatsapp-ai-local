const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createStore}=require('../lib/store.cjs');
const {pruneState}=require('../lib/housekeeping.cjs');

async function temp(t) {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const rows=(dir,sql,...args)=>{const db=new DatabaseSync(path.join(dir,'atendimento.sqlite'));try {return db.prepare(sql).all(...args);}finally {db.close();}};

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
  const before=new Map(rows(dir,"SELECT key, rowid FROM entries WHERE collection='contacts' ORDER BY rowid").map(row=>[row.key,row.rowid]));
  const result=await store.update(data=>{data.contacts.c7.status='closed';Object.keys(data.contacts).length;return data.contacts;});
  assert.equal(result.c7.status,'closed');assert.equal(Object.getPrototypeOf(result),Object.prototype);
  const after=rows(dir,"SELECT key, rowid, value FROM entries WHERE collection='contacts' ORDER BY rowid");
  assert.equal(after.length,50);assert.deepEqual(after.map(row=>row.key),[...before.keys()],'a ordem e as linhas são preservadas');
  assert.equal(JSON.parse(after.find(row=>row.key==='c7').value).status,'closed');
  await store.update(data=>{delete data.contacts.c3;delete data.extra;data.replyClaims.k2={owner:'triggers',claimedAt:'2026-11-02T00:00:00.000Z'};data.flag=undefined;data.list=[1,2];});
  await store.update(data=>{data.requests={r1:{hash:'h',at:1}};});
  const reopened=await createStore(dir).read();
  assert.equal(Object.keys(reopened.contacts).length,49);assert.equal(reopened.contacts.c3,undefined);assert.equal(Object.hasOwn(reopened,'extra'),false);assert.equal(Object.hasOwn(reopened,'flag'),false);
  assert.deepEqual(Object.keys(reopened.replyClaims),['k1','k2']);assert.deepEqual(reopened.list,[1,2]);assert.deepEqual(reopened.requests,{r1:{hash:'h',at:1}});
  assert.equal(JSON.stringify(reopened.contacts.c7),'{"status":"closed","n":7}');
  assert.equal(rows(dir,"SELECT COUNT(*) AS n FROM entries WHERE collection='requests'")[0].n,1);
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
