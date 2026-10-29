const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
let createTriggerService;try {({createTriggerService}=require('../lib/triggers.cjs'));}catch(error){if(error.code!=='MODULE_NOT_FOUND') throw error;}
const jid='5511998765432@s.whatsapp.net';
const incoming=(id,timestamp,extra={})=>({id,jid,timestamp,type:'text',text:'Qual o preço?',fromMe:false,key:{id,remoteJid:jid,fromMe:false},...extra});
const keyword={id:'price',name:'Preço',enabled:true,type:'keyword',keywords:['preço'],match:'word',delaySeconds:0,messages:[{type:'text',text:'Valores sob consulta.'}]};
async function fixture(t) {
  assert.equal(typeof createTriggerService,'function');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-triggers-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(dir);let clock=Date.parse('2026-10-29T12:00:00Z'),rows=[],records=[];
  const sent=[],client={chats:async()=>rows,messages:async(target,page=1)=>({messages:records.filter(m=>m.jid===target).slice((page-1)*50,page*50),pages:Math.ceil(records.length/50)||1}),sendText:async(to,text)=>{sent.push({type:'text',to,text});return {id:'sent-'+sent.length};},sendMedia:async(to,input)=>{sent.push({type:'media',to,...input});return {id:'sent-'+sent.length};},sendPoll:async(to,input)=>{sent.push({type:'poll',to,...input});return {id:'sent-'+sent.length};}};
  const service=createTriggerService({store,client,now:()=>clock});t.after(()=>service.stop());
  return {store,client,service,sent,now:()=>clock,advance:ms=>{clock+=ms;},records:list=>{records=list;},chats:list=>{rows=list;},receive:(id='new',extra={})=>{const message=incoming(id,clock,extra);records.unshift(message);rows=[{jid,lastMessage:message}];return message;}};
}
test('gatilhos começam desligados, validam regras e simulam sem enviar',async t=>{
  const f=await fixture(t);assert.equal((await f.service.settings()).enabled,false);
  await f.service.saveSettings({rules:[keyword]});assert.equal((await f.service.simulate({text:'PRECO?'})).rule.id,'price');assert.equal((await f.service.simulate({text:'precocemente'})).matched,false);assert.equal(f.sent.length,0);
  for(const input of [{enabled:'yes'},{rules:[{...keyword,delaySeconds:-1}]},{rules:[{...keyword,type:'other'}]},{rules:[{...keyword,messages:[]}]},{rules:[{...keyword,timezone:'Invalid/Zone'}]},{rules:[{...keyword,messages:[{type:'audio',base64:'not base64',mimeType:'audio/ogg',fileName:'x.ogg'}]}]}]) await assert.rejects(f.service.saveSettings(input),e=>e.status===422);
});
test('ausência respeita dias, fuso e expediente que atravessa meia-noite',async t=>{
  const f=await fixture(t);await f.service.saveSettings({rules:[{...keyword,type:'absence',timezone:'America/Sao_Paulo',schedule:{days:[1,2,3,4,5],start:'22:00',end:'06:00'}}]});
  assert.equal((await f.service.simulate({text:'oi',at:'2026-10-30T02:00:00Z'})).matched,false);
  assert.equal((await f.service.simulate({text:'oi',at:'2026-10-30T10:00:00Z'})).matched,true);
  assert.equal((await f.service.simulate({text:'oi',at:'2026-10-31T07:00:00Z'})).matched,false);
  assert.equal((await f.service.simulate({text:'oi',at:'2026-11-01T02:00:00Z'})).matched,true);
});
test('inatividade e primeiro contato usam histórico real, não agenda',async t=>{
  const f=await fixture(t);await f.store.update(data=>{data.contacts[jid]={name:'Salvo na agenda'};});
  await f.service.saveSettings({enabled:true,rules:[{...keyword,type:'first_contact'}]});f.advance(1000);f.receive();await f.service.tick();assert.equal(f.sent.length,1);
  f.advance(61000);f.receive('second');await f.service.tick();assert.equal(f.sent.length,1);
  await f.service.saveSettings({rules:[{...keyword,inactiveDays:3}]});
  assert.equal((await f.service.simulate({text:'preço',previousMessageAt:new Date(f.now()-2*86400000).toISOString()})).matched,false);
  assert.equal((await f.service.simulate({text:'preço',previousMessageAt:new Date(f.now()-4*86400000).toISOString()})).matched,true);
});
test('ativação e reinício não respondem histórico nem consideram conversa existente nova',async t=>{
  const f=await fixture(t);const old=incoming('old',f.now()-86400000);f.records([old]);f.chats([{jid,lastMessage:old}]);await f.service.saveSettings({enabled:true,rules:[{...keyword,type:'first_contact'}]});
  f.advance(1000);f.receive();await f.service.tick();assert.equal(f.sent.length,0);
  await f.service.saveSettings({rules:[keyword]});const restarted=createTriggerService({store:f.store,client:f.client,now:f.now});await restarted.tick();assert.equal(f.sent.length,0);restarted.stop();
});
test('apenas entrada individual íntegra e recente pode enviar; a reserva é persistente',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[keyword]});f.advance(1000);f.receive('valid');
  await Promise.all([f.service.tick(),f.service.tick()]);await f.service.tick();assert.equal(f.sent.length,1);assert.equal((await f.service.executions())[0].status,'sent');
  const state=await f.store.read();assert.equal(Object.values(state.replyClaims)[0].owner,'triggers');
  f.advance(61000);f.receive('out',{fromMe:true});await f.service.tick();assert.equal(f.sent.length,1);
  f.receive('bad-key',{key:{id:'bad-key',remoteJid:jid}});await f.service.tick();assert.equal(f.sent.length,1);
});
test('atraso e sequência são cancelados por pausa, edição, resposta manual ou desligamento',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[{...keyword,delaySeconds:30}]});f.advance(1000);f.receive();await f.service.tick();assert.equal(f.sent.length,0);assert.equal((await f.service.executions())[0].status,'queued');
  await f.store.update(data=>{data.contacts[jid]={automationPaused:true};});f.advance(31000);await f.service.tick();assert.equal(f.sent.length,0);assert.equal((await f.service.executions())[0].status,'skipped_paused');
  await f.store.update(data=>{data.contacts[jid].automationPaused=false;});f.advance(61000);f.receive('next');await f.service.tick();await f.service.saveSettings({enabled:false});f.advance(31000);await f.service.tick();assert.equal(f.sent.length,0);
});
test('reinício nunca retoma envio atrasado e erro de envio não revela segredos nem tenta de novo',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[{...keyword,delaySeconds:30}]});f.advance(1000);f.receive();await f.service.tick();
  f.advance(31000);const restarted=createTriggerService({store:f.store,client:f.client,now:f.now});assert.equal((await restarted.executions())[0].status,'uncertain');await restarted.tick();assert.equal(f.sent.length,0);restarted.stop();
  await f.service.saveSettings({rules:[keyword]});f.advance(61000);f.receive('failure');f.client.sendText=async()=>{f.sent.push({failure:true});throw new Error('apikey=SECRET');};await f.service.tick();await f.service.tick();assert.equal(f.sent.length,1);assert.equal((await f.service.executions())[0].status,'uncertain');assert.doesNotMatch(JSON.stringify(await f.service.executions()),/SECRET/);
});
test('respostas de texto, mídia e enquete mantêm ordem e param depois de erro incerto',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[{...keyword,messages:[...keyword.messages,{type:'audio',base64:'aGk=',mimeType:'audio/ogg',fileName:'oi.ogg'},{type:'poll',name:'Qual serviço?',options:['Importação','Passagens'],selectableCount:1}]}]});f.advance(1000);f.receive();await f.service.tick();assert.deepEqual(f.sent.map(item=>item.type),['text','media','poll']);assert.equal(f.sent[1].mediaType,'audio');assert.equal((await f.service.executions())[0].sentCount,3);
});
test('edição durante consulta final cancela envio e claim compartilhado impede resposta dupla',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[keyword]});f.advance(1000);const message=f.receive();
  const {createHash}=require('node:crypto');const key=createHash('sha256').update(jid+'\0'+message.id).digest('hex');await f.store.update(data=>{data.replyClaims={[key]:{owner:'assistant',claimedAt:new Date(f.now()).toISOString()}};});await f.service.tick();assert.equal(f.sent.length,0);
  f.advance(61000);f.receive('race');const chats=f.client.chats;let calls=0;f.client.chats=async()=>{const result=await chats();if(++calls===2) await f.service.saveSettings({enabled:false});return result;};await f.service.tick();assert.equal(f.sent.length,0);
});

test('gatilhos e robô legado compartilham reserva para nunca responder duas vezes',async t=>{
  const {createAutomationService}=require('../lib/automation.cjs');
  const f=await fixture(t),legacy=createAutomationService({store:f.store,client:f.client,now:f.now});t.after(()=>legacy.stop());
  await f.service.saveSettings({enabled:true,rules:[keyword]});await legacy.saveSettings({enabled:true,rules:[{id:'legacy',name:'Legado',enabled:true,keywords:['preço'],match:'word',response:'Resposta legada'}]});
  f.advance(1000);f.receive();await f.service.tick();await legacy.tick();assert.equal(f.sent.length,1);
  f.advance(61000);f.receive('legacy-first');await legacy.tick();await f.service.tick();assert.equal(f.sent.length,2);assert.equal(Object.values((await f.store.read()).replyClaims).filter(claim=>claim.owner==='automation').length,1);
});
test('robô legado cancela quando alguém responde durante a consulta final',async t=>{
  const {createAutomationService}=require('../lib/automation.cjs');
  const f=await fixture(t),legacy=createAutomationService({store:f.store,client:f.client,now:f.now});t.after(()=>legacy.stop());
  await legacy.saveSettings({enabled:true,rules:[{id:'legacy',name:'Legado',enabled:true,keywords:['preço'],match:'word',response:'Resposta legada'}]});f.advance(1000);f.receive();
  const chats=f.client.chats;let calls=0;f.client.chats=async()=>{const rows=await chats();if(++calls>1) return [{jid,lastMessage:{id:'manual',fromMe:true}}];return rows;};await legacy.tick();assert.equal(f.sent.length,0);
});
test('atraso cancela mensagem editada e sequência para se houver nova entrada',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[{...keyword,delaySeconds:30}]});f.advance(1000);const message=f.receive();await f.service.tick();
  f.chats([{jid,lastMessage:{...message,text:'Não preciso mais'}}]);f.advance(31000);await f.service.tick();assert.equal(f.sent.length,0);
  await f.service.saveSettings({rules:[{...keyword,messages:[...keyword.messages,{type:'text',text:'Segunda resposta'}]}]});f.advance(61000);f.receive('sequence');
  const send=f.client.sendText;f.client.sendText=async(...args)=>{const result=await send(...args);f.receive('interrupt');return result;};await f.service.tick();assert.equal(f.sent.length,1);assert.equal((await f.service.executions())[0].status,'skipped_replied');
});
test('gatilhos respeitam pausa de alias e limite total de anexos antes de persistir',async t=>{
  const f=await fixture(t),alias='123456789012345@lid';await f.service.saveSettings({enabled:true,rules:[keyword]});await f.store.update(data=>{data.contacts[alias]={automationPaused:true};});f.advance(1000);const message=f.receive();f.chats([{jid,aliasJids:[alias],lastMessage:message}]);await f.service.tick();assert.equal(f.sent.length,0);
  const base64=Buffer.alloc(6*1024*1024).toString('base64');await assert.rejects(f.service.saveSettings({rules:[{...keyword,messages:[{type:'document',base64,mimeType:'application/pdf',fileName:'a.pdf'},{type:'document',base64,mimeType:'application/pdf',fileName:'b.pdf'}]}]}),error=>error.status===422);assert.equal((await f.service.settings()).rules[0].messages[0].type,'text');
});
test('robô legado cancela edição no mesmo identificador da mensagem',async t=>{
  const {createAutomationService}=require('../lib/automation.cjs');const f=await fixture(t),legacy=createAutomationService({store:f.store,client:f.client,now:f.now});t.after(()=>legacy.stop());
  await legacy.saveSettings({enabled:true,rules:[{id:'legacy',name:'Legado',enabled:true,keywords:['preço'],match:'word',response:'Resposta legada'}]});f.advance(1000);const message=f.receive();const chats=f.client.chats;let calls=0;f.client.chats=async()=>++calls>1?[{jid,lastMessage:{...message,text:'Já resolvi'}}]:chats();await legacy.tick();assert.equal(f.sent.length,0);
});
test('boas-vindas por gatilho ou robô legado preservam continuidade da IA para contato novo',async t=>{
  const {createAutomationService}=require('../lib/automation.cjs'),{createAssistantService}=require('../lib/assistant.cjs');
  for(const owner of ['triggers','automation']) {
    const f=await fixture(t),assistant=createAssistantService({store:f.store,client:f.client,now:f.now,ai:{config:async()=>({configured:true}),complete:async()=> 'Resposta da IA'},loadTexts:async()=>[],catalogText:async()=>''});t.after(()=>assistant.stop());
    await f.store.update(data=>{data.assistant={enabled:true,audience:'new',enabledSince:new Date(f.now()).toISOString(),newCohort:'cohort',known:{}};});
    const service=owner==='triggers'?f.service:createAutomationService({store:f.store,client:f.client,now:f.now});t.after(()=>service.stop());
    await service.saveSettings({enabled:true,rules:owner==='triggers'?[{...keyword,type:'first_contact'}]:[{id:'welcome',name:'Boas-vindas',enabled:true,keywords:['preço'],match:'word',response:'Boas-vindas'}]});
    f.advance(1000);f.receive('initial-first');f.advance(1000);f.receive();await service.tick();assert.equal(f.sent.length,1,owner);
    f.advance(61000);f.receive('followup',{text:'Agora outra dúvida'});await assistant.tick();assert.equal(f.sent.length,2,owner);assert.equal(f.sent[1].text,'Resposta da IA');
  }
});
test('texto substitui nome com segurança e preserva variáveis desconhecidas',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[{...keyword,messages:[{type:'text',text:'Olá {nome}! {name} - {pedido}'}]}]});f.advance(1000);const message=f.receive();f.chats([{jid,name:'Ana Silva',lastMessage:message}]);await f.service.tick();assert.equal(f.sent[0].text,'Olá Ana Silva! Ana Silva - {pedido}');
  f.advance(61000);const next=f.receive('numeric');f.chats([{jid,name:'55 (11) 99876-5432',lastMessage:next}]);await f.service.tick();assert.equal(f.sent[1].text,'Olá você! você - {pedido}');
});
test('robô legado respeita pausa no alias antes e depois da consulta final',async t=>{
  const {createAutomationService}=require('../lib/automation.cjs'),alias='123456789012345@lid';
  for(const late of [false,true]) {
    const f=await fixture(t),legacy=createAutomationService({store:f.store,client:f.client,now:f.now});t.after(()=>legacy.stop());await legacy.saveSettings({enabled:true,rules:[{id:'legacy',name:'Legado',enabled:true,keywords:['preço'],match:'word',response:'Resposta legada'}]});f.advance(1000);const message=f.receive();f.chats([{jid,aliasJids:[alias],lastMessage:message}]);
    if(!late) await f.store.update(data=>{data.contacts[alias]={automationPaused:true};});else {const chats=f.client.chats;let calls=0;f.client.chats=async()=>{const rows=await chats();if(++calls===2) await f.store.update(data=>{data.contacts[alias]={automationPaused:true};});return rows;};}
    await legacy.tick();assert.equal(f.sent.length,0,late?'pausa tardia':'pausa inicial');
  }
});
test('gatilho de primeiro contato aceita lote inicial e reserva a entrada em todos os aliases',async t=>{
  const f=await fixture(t),alias='123456789012345@lid';await f.service.saveSettings({enabled:true,rules:[{...keyword,type:'first_contact'}]});f.advance(1000);f.receive('first');f.advance(1000);const message=f.receive('second');f.chats([{jid,aliasJids:[alias],lastMessage:message}]);await f.service.tick();assert.equal(f.sent.length,1);
  const {claimKey}=require('../lib/triggers.cjs');assert.equal((await f.store.read()).replyClaims[claimKey(alias,message.id)].owner,'triggers');
});
