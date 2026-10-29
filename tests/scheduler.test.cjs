const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createScheduler}=require('../lib/scheduler.cjs');
const jid='5511998765432@s.whatsapp.net',start=Date.parse('2026-10-29T12:00:00Z');
async function fixture(t,overrides={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-scheduler-test-'));let current=start,connected=true,scheduler;const sends=[];
  t.after(async()=>{await scheduler?.idle();assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^wa-scheduler-test-/);await fs.rm(directory,{recursive:true,force:true});});
  const store=createStore(directory),client={connection:async()=>({state:connected?'connected':'disconnected'}),sendText:async(...args)=>{sends.push(args);return {id:'sent-1'};},...overrides};
  scheduler=createScheduler({store,client,now:()=>current});return {scheduler,store,client,directory,sends,setTime:value=>current=value,setConnected:value=>connected=value};
}
const input=(extra={})=>({jid,text:'Mensagem programada',scheduledAt:'2026-10-29T09:01:00-03:00',requestId:'schedule-test-001',...extra});
test('agenda persistente respeita instante/fuso, não envia cedo e deduplica criação/execução',async t=>{
  const f=await fixture(t),job=await f.scheduler.create(input());assert.equal(job.scheduledAt,'2026-10-29T12:01:00.000Z');
  assert.equal((await f.scheduler.create(input())).id,job.id);await f.scheduler.tick();assert.equal(f.sends.length,0);
  f.setTime(start+61000);await Promise.all([f.scheduler.tick(),f.scheduler.tick()]);assert.equal(f.sends.length,1);assert.equal((await f.scheduler.list())[0].status,'sent');
  const restarted=createScheduler({store:createStore(f.directory),client:f.client,now:()=>start+62000});await restarted.tick();assert.equal(f.sends.length,1);
  assert.equal((await f.scheduler.create(input())).status,'sent');assert.equal(f.sends.length,1);
  await assert.rejects(f.scheduler.create(input({text:'Outro texto'})),{status:409});
});
test('cancelar e editar antes do horário preserva outros dados e evita envio',async t=>{
  const f=await fixture(t),job=await f.scheduler.create(input());await f.store.update(data=>{data.contacts[jid]={notes:[{text:'Nota pessoal'}]};});
  await f.scheduler.update(job.id,{text:'Texto atualizado',scheduledAt:new Date(start+120000).toISOString()});assert.equal((await f.scheduler.list())[0].text,'Texto atualizado');
  f.setTime(start+61000);await f.scheduler.tick();assert.equal(f.sends.length,0);
  await f.scheduler.cancel(job.id);f.setTime(start+130000);await f.scheduler.tick();assert.equal(f.sends.length,0);assert.equal((await f.scheduler.list())[0].status,'cancelled');assert.equal((await f.store.read()).contacts[jid].notes[0].text,'Nota pessoal');
});
test('rejeita datas passadas, inválidas e entradas de envio arbitrárias',async t=>{
  const f=await fixture(t);
  for(const value of [input({scheduledAt:'2026-10-29T11:00:00Z'}),input({scheduledAt:'2026-02-30T12:00:00Z'}),input({scheduledAt:'2026-10-29T12:00:00'}),input({jid:'123@g.us'}),input({text:''}),input({text:'a'.repeat(10001)}),input({requestId:'../id'})]) await assert.rejects(f.scheduler.create(value),{status:422});
  await assert.rejects(f.scheduler.list('../jid'),{status:422});assert.equal(f.sends.length,0);
});
test('desconectado aguarda, reconecta na tolerância e atraso grande exige remarcar',async t=>{
  const f=await fixture(t);await f.scheduler.create(input());f.setConnected(false);f.setTime(start+61000);await f.scheduler.tick();assert.equal(f.sends.length,0);assert.equal((await f.scheduler.list())[0].status,'scheduled');
  f.setConnected(true);f.setTime(start+120000);await f.scheduler.tick();assert.equal(f.sends.length,1);
  const next=await f.scheduler.create(input({requestId:'schedule-test-002',scheduledAt:new Date(start+180000).toISOString()}));f.setTime(start+180000+16*60000);await f.scheduler.tick();assert.equal((await f.scheduler.list()).find(j=>j.id===next.id).status,'missed');assert.equal(f.sends.length,1);
  await f.scheduler.update(next.id,{scheduledAt:new Date(start+180000+18*60000).toISOString()});assert.equal((await f.scheduler.list()).find(j=>j.id===next.id).status,'scheduled');
});
test('falha após início e reinício durante envio ficam incertos sem repetição',async t=>{
  const f=await fixture(t,{sendText:async()=>{f.sends.push('attempt');throw Error('segredo do provedor');}});await f.scheduler.create(input());f.setTime(start+61000);await f.scheduler.tick();await f.scheduler.tick();assert.equal(f.sends.length,1);
  const job=(await f.scheduler.list())[0];assert.equal(job.status,'uncertain');assert.doesNotMatch(job.lastError,/segredo/);await assert.rejects(f.scheduler.update(job.id,{scheduledAt:new Date(start+120000).toISOString()}),{status:409});
  await f.store.update(data=>{data.scheduledMessages[job.id].status='sending';});
  const restarted=createScheduler({store:createStore(f.directory),client:f.client,now:()=>start+62000});await restarted.tick();assert.equal(f.sends.length,1);assert.equal((await restarted.list())[0].status,'uncertain');
});
test('cancelamento durante consulta de conexão e stop impedem envio ainda não iniciado',async t=>{
  let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const f=await fixture(t,{connection:async()=>{started();await gate;return {state:'connected'};}});const job=await f.scheduler.create(input());f.setTime(start+61000);const ticking=f.scheduler.tick();await entered;await f.scheduler.cancel(job.id);release();await ticking;assert.equal(f.sends.length,0);
  f.scheduler.stop();await f.scheduler.tick();assert.equal(f.sends.length,0);
});
