const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
let createCrmService;try {({createCrmService}=require('../lib/crm.cjs'));}catch(error){if(error.code!=='MODULE_NOT_FOUND') throw error;}
const jid='5511998765432@s.whatsapp.net';
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-crm-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return {dir,store:createStore(dir)};
}
test('CRM disponibiliza serviço independente',()=>assert.equal(typeof createCrmService,'function'));
test('CRM preserva notas do atendimento, outros dados e mudanças após reinício',async t=>{
  assert.equal(typeof createCrmService,'function');const {dir,store}=await fixture(t);
  await store.update(data=>{data.contacts[jid]={notes:[{text:'Nota existente'}],labels:['Milhas'],status:'pending'};data.custom={keep:true};});
  const crm=createCrmService({store});
  const initial=await crm.list([{jid,name:'Ana',unread:2}]);assert.equal(initial.contacts[0].crm.stage,'new');assert.equal(initial.contacts[0].crm.notes,'');assert.equal(initial.stages.length,5);
  const saved=await crm.update(jid,{stage:'negotiating',followUpAt:'2026-11-01T12:00:00-03:00',notes:'Confirmar proposta',automationPaused:true});
  assert.equal(saved.crm.stage,'negotiating');assert.equal(saved.crm.followUpAt,'2026-11-01T15:00:00.000Z');assert.equal(saved.automationPaused,true);
  const reopened=createCrmService({store:createStore(dir)});const rows=await reopened.list([{jid,name:'Ana'}]);
  assert.equal(rows.contacts[0].crm.notes,'Confirmar proposta');assert.equal(rows.contacts[0].crm.history.length,2);
  const data=await createStore(dir).read();assert.deepEqual(data.contacts[jid].notes,[{text:'Nota existente'}]);assert.deepEqual(data.custom,{keep:true});
});
test('CRM rejeita contatos, etapas, notas e datas inválidas sem alterar estado',async t=>{
  assert.equal(typeof createCrmService,'function');const {store}=await fixture(t);const crm=createCrmService({store});
  for(const [target,input] of [['123@g.us',{stage:'new'}],[jid,{stage:'admin'}],[jid,{followUpAt:'amanhã'}],[jid,{followUpAt:'2026-11-01'}],[jid,{followUpAt:'2026-02-30T12:00:00Z'}],[jid,{notes:[]}],[jid,{notes:'x'.repeat(10001)}],[jid,{automationPaused:'yes'}]]) await assert.rejects(crm.update(target,input),error=>error.status===422);
  assert.deepEqual((await store.read()).contacts,{});
});
test('CRM limita histórico e mantém atualizações concorrentes de campos diferentes',async t=>{
  assert.equal(typeof createCrmService,'function');const {store}=await fixture(t);const crm=createCrmService({store});
  await Promise.all([crm.update(jid,{notes:'Observação'}),crm.update(jid,{automationPaused:true})]);
  for(let n=0;n<105;n++) await crm.update(jid,{stage:n%2?'new':'contacted'});
  const row=(await crm.list([{jid}])).contacts[0];assert.equal(row.crm.notes,'Observação');assert.equal(row.automationPaused,true);assert.equal(row.crm.history.length,100);
  await crm.update(jid,{followUpAt:null});assert.equal((await crm.list([{jid}])).contacts[0].crm.followUpAt,null);
});
