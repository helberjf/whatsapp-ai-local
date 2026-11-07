const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {pruneState}=require('../lib/housekeeping.cjs');

async function temp(t) {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

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
