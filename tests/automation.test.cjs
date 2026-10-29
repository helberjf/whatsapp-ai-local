const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
let createAutomationService;try {({createAutomationService}=require('../lib/automation.cjs'));}catch(error){if(error.code!=='MODULE_NOT_FOUND') throw error;}
const jid='5511998765432@s.whatsapp.net';
const rule={id:'preco',name:'Preço',keywords:['preço'],match:'word',response:'Posso ajudar com os valores.',enabled:true};
const incoming=(id,timestamp,overrides={})=>({id,jid,timestamp,type:'text',fromMe:false,text:'Qual o PREÇO?',key:{id,remoteJid:jid,fromMe:false},...overrides});
async function fixture(t) {
  assert.equal(typeof createAutomationService,'function');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-automation-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-28T12:00:00Z'),records=[],chatRows=[{jid,name:'Ana'}],failure=false,onMessages=null;
  const sent=[],pages=[];const store=createStore(dir),now=()=>clock;
  const client={chats:async()=>chatRows,messages:async(target,page=1)=>{pages.push(page);if(onMessages) await onMessages();const sorted=records.slice().sort((a,b)=>b.timestamp-a.timestamp);return {messages:sorted.slice((page-1)*50,page*50),pages:Math.ceil(records.length/50)||1,page};},sendText:async(target,text)=>{sent.push({jid:target,text});if(failure) throw new Error('apikey=SECRET');return {id:'reply-'+sent.length};}};
  const service=createAutomationService({store,client,now});t.after(()=>service.stop());
  return {dir,store,client,now,service,sent,pages,setRecords:value=>{records=value;},setChats:value=>{chatRows=value;},advance:ms=>{clock+=ms;},fail:()=>{failure=true;},onMessages:fn=>{onMessages=fn;}};
}
test('robô disponibiliza serviço independente',()=>assert.equal(typeof createAutomationService,'function'));
test('começa desligado e simula primeira regra sem enviar, ignorando acentos e caixa',async t=>{
  const f=await fixture(t);assert.equal((await f.service.settings()).enabled,false);assert.deepEqual((await f.service.settings()).rules,[]);
  await f.service.saveSettings({rules:[rule,{...rule,id:'contains',keywords:['valor'],match:'contains'}]});
  const result=await f.service.simulate({text:'Qual o preco?'});assert.equal(result.matched,true);assert.equal(result.rule.id,'preco');assert.equal(result.reply,rule.response);
  assert.equal((await f.service.simulate({text:'precocemente'})).matched,false);assert.equal((await f.service.simulate({text:'valores'})).matched,true);assert.equal(f.sent.length,0);
});
test('palavras são literais e valida configurações antes de persistir',async t=>{
  const f=await fixture(t);await f.service.saveSettings({rules:[{...rule,keywords:['[a-z]+'],match:'contains'}]});
  assert.equal((await f.service.simulate({text:'abc'})).matched,false);assert.equal((await f.service.simulate({text:'Use [a-z]+'})).matched,true);
  for(const input of [{cooldownSeconds:9},{cooldownSeconds:86401},{enabled:'yes'},{rules:[{...rule,match:'regex'}]},{rules:[{...rule,keywords:[]}]},{rules:[{...rule,response:''}]},{rules:[rule,rule]}]) await assert.rejects(f.service.saveSettings(input),error=>error.status===422);
});
test('ignora histórico, saídas, grupos, mídia, sistema e chaves inconsistentes',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});const baseline=f.now();f.advance(2000);
  f.setChats([{jid},{jid:'123@g.us'}]);f.setRecords([
    incoming('old',baseline-1000),incoming('same',baseline),incoming('out',f.now(),{fromMe:true,key:{id:'out',remoteJid:jid,fromMe:true}}),
    incoming('group',f.now(),{jid:'123@g.us',key:{id:'group',remoteJid:'123@g.us',fromMe:false}}),incoming('media',f.now(),{type:'image'}),
    incoming('system',f.now(),{type:'text',key:{id:'system',remoteJid:jid}}),incoming('wrong-jid',f.now(),{key:{id:'wrong-jid',remoteJid:'5511888888888@s.whatsapp.net',fromMe:false}}),incoming('fresh',f.now())
  ]);await f.service.tick();assert.deepEqual(f.sent,[{jid,text:rule.response}]);
});
test('deduplica ticks concorrentes, instâncias e reinício; falha incerta não reenvia nem expõe segredo',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});f.advance(1000);f.setRecords([incoming('new',f.now())]);f.fail();
  const other=createAutomationService({store:f.store,client:f.client,now:()=>f.now()-1000});
  await Promise.all([f.service.tick(),f.service.tick(),other.tick()]);await f.service.tick();assert.equal(f.sent.length,1);
  const restarted=createAutomationService({store:createStore(f.dir),client:f.client,now:f.now});await restarted.tick();assert.equal(f.sent.length,1);
  const events=await restarted.executions();assert.equal(events[0].status,'uncertain');assert.doesNotMatch(JSON.stringify(events),/SECRET|apikey/);other.stop();restarted.stop();
});
test('respeita pausa por contato e cooldown persistente sem responder mensagens antigas depois',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,cooldownSeconds:10,rules:[rule]});f.advance(1000);
  await f.store.update(data=>{data.contacts[jid]={notes:[{text:'preservar'}],automationPaused:true};});f.setRecords([incoming('paused',f.now())]);await f.service.tick();assert.equal(f.sent.length,0);
  await f.store.update(data=>{data.contacts[jid].automationPaused=false;});await f.service.tick();assert.equal(f.sent.length,0);
  f.advance(1000);f.setRecords([incoming('first',f.now())]);await f.service.tick();assert.equal(f.sent.length,1);
  f.advance(1000);f.setRecords([incoming('cooldown',f.now())]);await f.service.tick();assert.equal(f.sent.length,1);
  f.advance(11000);await f.service.tick();assert.equal(f.sent.length,1);f.setRecords([incoming('later',f.now())]);await f.service.tick();assert.equal(f.sent.length,2);
  assert.deepEqual((await f.store.read()).contacts[jid].notes,[{text:'preservar'}]);
});
test('reconfere desligamento e pausa antes do envio, sem sobrescrever configuração recente',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});f.advance(1000);f.setRecords([incoming('new',f.now())]);
  f.onMessages(async()=>{await f.service.saveSettings({enabled:false,cooldownSeconds:120});});await f.service.tick();assert.equal(f.sent.length,0);assert.equal((await f.service.settings()).cooldownSeconds,120);
  f.onMessages(null);f.advance(1000);await f.service.saveSettings({enabled:true});f.advance(1000);f.setRecords([incoming('newer',f.now())]);
  f.onMessages(()=>f.store.update(data=>{data.contacts[jid]={automationPaused:true};}));await f.service.tick();assert.equal(f.sent.length,0);
});
test('reinício e reativação criam nova linha de base e stop cancela envios pendentes',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});f.advance(2000);f.setRecords([incoming('offline',f.now()-1000)]);
  const restarted=createAutomationService({store:createStore(f.dir),client:f.client,now:f.now});await restarted.tick();assert.equal(f.sent.length,0);
  f.onMessages(async()=>{f.service.stop();});f.setRecords([incoming('stopped',f.now())]);await f.service.tick();assert.equal(f.sent.length,0);restarted.stop();
});
test('pagina mais de cinquenta mensagens novas sem envio duplicado',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});const base=f.now();f.advance(2000);f.setRecords(Array.from({length:85},(_,i)=>incoming('bulk-'+i,base+100+i)));
  await f.service.tick();assert.ok(f.pages.includes(2));assert.equal(f.sent.length,1);assert.equal((await f.service.executions()).length,85);await f.service.tick();assert.equal(f.sent.length,1);
});
test('interrompe quando o contato é pausado enquanto a reserva de envio termina',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});f.advance(1000);f.setRecords([incoming('late-pause',f.now())]);
  const update=f.store.update;let injected=false;
  f.store.update=async fn=>{
    const result=await update(fn);
    if(result===true && !injected) {injected=true;await update(data=>{data.contacts[jid]={automationPaused:true};});}
    return result;
  };
  await f.service.tick();assert.equal(f.sent.length,0);assert.equal((await f.service.executions())[0].status,'skipped_paused');
});
test('limite por consulta preserva vez das conversas restantes na próxima consulta',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});f.advance(1000);
  const ids=Array.from({length:45},(_,n)=>'551199'+String(n).padStart(7,'0')+'@s.whatsapp.net'),queried=new Set();
  f.setChats(ids.map(jid=>({jid})));f.client.messages=async jid=>{queried.add(jid);return {messages:[incoming('irrelevant',f.now(),{type:'image'})],pages:3};};
  for(let n=0;n<4;n++) await f.service.tick();assert.equal(queried.size,45);
});
test('não baixa histórico quando última mensagem é antiga nem repete consulta sem mensagem nova',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});const baseline=f.now();
  f.setChats([{jid,lastMessage:incoming('old',baseline-1000)}]);await f.service.tick();assert.deepEqual(f.pages,[]);
  f.advance(1000);const latest=incoming('new',f.now());f.setChats([{jid,lastMessage:latest}]);f.setRecords([latest]);await f.service.tick();assert.deepEqual(f.pages,[1]);await f.service.tick();assert.deepEqual(f.pages,[1]);
  f.advance(1000);const another=incoming('another',f.now());f.setChats([{jid,lastMessage:another}]);f.setRecords([latest,another]);await f.service.tick();assert.deepEqual(f.pages,[1,1]);assert.equal(f.sent.length,1);
});
test('continua paginação pendente mesmo quando assinatura da última mensagem não muda',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});const baseline=f.now();f.advance(5000);
  const records=Array.from({length:600},(_,i)=>incoming('bulk-'+i,baseline+1+i,{type:'image'}));f.setRecords(records);f.setChats([{jid,lastMessage:records.at(-1)}]);
  await f.service.tick();assert.equal(Math.max(...f.pages),10);await f.service.tick();assert.ok(f.pages.includes(12));const count=f.pages.length;await f.service.tick();assert.equal(f.pages.length,count);
});
test('reinício informa execuções interrompidas como incertas e não retoma os envios',async t=>{
  const f=await fixture(t);
  await f.store.update(data=>{data.automation={settings:{enabled:true,enabledSince:new Date(f.now()-5000).toISOString(),rules:[rule],cooldownSeconds:60},executions:[{id:'q',status:'queued',createdAt:new Date(f.now()-1000).toISOString()},{id:'s',status:'sending',createdAt:new Date(f.now()-1000).toISOString()}]};});
  const restarted=createAutomationService({store:f.store,client:f.client,now:f.now});const events=await restarted.executions();assert.deepEqual(events.map(item=>item.status),['uncertain','uncertain']);await restarted.tick();assert.equal(f.sent.length,0);restarted.stop();
});
test('desligar e reativar não remove a deduplicação de mensagem já respondida',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,cooldownSeconds:10,rules:[rule]});f.advance(1000);const message=incoming('clock-skew',f.now()+1000);f.setRecords([message]);await f.service.tick();assert.equal(f.sent.length,1);
  await f.service.saveSettings({enabled:false});await f.service.saveSettings({enabled:true});f.advance(11000);await f.service.tick();assert.equal(f.sent.length,1);
});
test('erro de persistência não marca conversa inteira como já consultada',async t=>{
  const f=await fixture(t);await f.service.saveSettings({enabled:true,rules:[rule]});f.advance(1000);const message=incoming('disk-recovered',f.now());f.setRecords([message]);f.setChats([{jid,lastMessage:message}]);
  const update=f.store.update;let fail=true;f.store.update=fn=>{if(fail) {fail=false;return Promise.reject(new Error('Disco ocupado'));}return update(fn);};
  await f.service.tick();assert.equal(f.sent.length,0);await f.service.tick();assert.equal(f.sent.length,1);
});
