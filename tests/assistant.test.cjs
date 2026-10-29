const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createAssistantService,applyMode}=require('../lib/assistant.cjs');
const core=require('../lib/assistant-core.cjs');
const {createWhatsAppServer}=require('../server.cjs');

const jid='5511998765432@s.whatsapp.net';
const CATALOG='SERVIÇOS\n- [Importação de produtos] Importação de produtos da China (valor sob consulta)';

async function setup({mode='draft',since=Date.now()-60_000,enabled=false}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-assistant-')),store=createStore(dir),clock={t:Date.now()};
  await store.update(data=>{data.contacts[jid]={status:'open',labels:[],notes:[],aiMode:mode,aiSince:new Date(since).toISOString()};if(enabled) data.assistant={enabled:true,enabledSince:new Date(since).toISOString()};});
  const env={dir,store,clock,sent:[],calls:[],reply:'Fazemos importação da China. Qual produto e quantidade?',
    chats:[{jid,name:'Ana',lastMessage:{id:'m1',fromMe:false,type:'text',text:'Vocês importam da China?',timestamp:clock.t+1000}}],
    messages:[{id:'m1',fromMe:false,type:'text',text:'Vocês importam da China?',timestamp:clock.t+1000}]};
  const client={chats:async()=>env.chats,messages:async()=>({messages:env.messages}),sendText:async(to,text)=>{env.sent.push({to,text});return {id:'out-'+env.sent.length};}};
  const ai={config:async()=>({configured:true}),complete:async options=>{env.calls.push(options);return env.reply;}};
  env.service=createAssistantService({store,client,ai,loadTexts:async()=>[{id:'1',name:'importacao.md',text:'Importação de produtos da China com frete internacional e desembaraço.'}],catalogText:async()=>CATALOG,now:()=>env.clock.t});
  env.contact=async()=>(await store.read()).contacts[jid];
  env.done=()=>fs.rm(dir,{recursive:true,force:true});
  return env;
}
const newMessage=(env,id,text,fromMe=false)=>{env.clock.t+=1000;const message={id,fromMe,type:'text',text,timestamp:env.clock.t};env.messages.push(message);env.chats[0].lastMessage=message;};

test('catálogo: separa produtos e serviços, ignora inativos e mostra preço e desconto',()=>{
  const text=core.catalogOverview([
    {name:'Passagens aéreas no Brasil',kind:'servico',category:'Passagens aéreas',price:null,active:true,description:'Voos nacionais.'},
    {name:'Importação da China',kind:'servico',category:'Importação de produtos',price:null,active:true},
    {name:'Sistema A',kind:'produto',category:'Sistemas prontos',price:1000,discountPercent:10,active:true},
    {name:'Escondido',kind:'produto',category:'Sistemas prontos',price:5,active:false}
  ]);
  assert.match(text,/^SERVIÇOS\n- \[Importação de produtos\] Importação da China \(valor sob consulta\)\n- \[Passagens aéreas\] Passagens aéreas no Brasil/);
  assert.match(text,/PRODUTOS\n- \[Sistemas prontos\] Sistema A \(R\$ 900,00 \(10% OFF\)\)/);
  assert.doesNotMatch(text,/Escondido/);
});

test('regras: padrão cobre importação (Europa/China/EUA) e passagens (Brasil/Mundo); edição é validada',()=>{
  const titles=core.DEFAULT_RULES.map(rule=>rule.title).join(' | ');
  assert.match(titles,/Importação de produtos \(Europa, China e EUA\)/);assert.match(titles,/Passagens aéreas \(Brasil e mundo\)/);
  const saved=core.normalizeRules([{title:'Nova',text:'Texto',enabled:false},{id:'x1',title:'Outra',text:'Mais'}]);
  assert.equal(saved[0].enabled,false);assert.equal(saved[1].id,'x1');assert.ok(saved[0].id.length>8);
  assert.throws(()=>core.normalizeRules([{title:'',text:'a'}]),/título/);
  assert.throws(()=>core.normalizeRules([{title:'a',text:''}]),/escreva o texto/);
  assert.throws(()=>core.normalizeRules(Array(31).fill({title:'a',text:'b'})),/até 30/);
  const system=core.buildSystem({rules:[{title:'Ligada',text:'faça X',enabled:true},{title:'Desligada',text:'faça Y',enabled:false}],catalog:CATALOG,sources:[]});
  assert.match(system,/- Ligada: faça X/);assert.doesNotMatch(system,/Desligada/);assert.match(system,/<catalogo>[\s\S]*Importação de produtos da China[\s\S]*<\/catalogo>/);
});

test('rascunho: a IA prepara a resposta uma vez, com catálogo, base e histórico, sem enviar nada',async()=>{
  const env=await setup({mode:'draft'});
  try {
    env.messages.unshift({id:'m0',fromMe:true,type:'text',text:'Olá! Como posso ajudar?',timestamp:Date.now()-5000});
    await env.service.tick();
    const contact=await env.contact();
    assert.equal(contact.aiDraft.text,env.reply);assert.equal(contact.aiDraft.messageId,'m1');
    assert.equal(env.sent.length,0);
    const call=env.calls[0];
    assert.match(call.system,/Importação de produtos da China \(valor sob consulta\)/);assert.match(call.system,/<contexto>[\s\S]*desembaraço/);
    assert.deepEqual(call.messages.map(turn=>turn.role),['assistant','user'].slice(1));
    await env.service.tick();assert.equal(env.calls.length,1,'A mesma mensagem não é processada duas vezes.');
    // Quando alguém responde, o rascunho antigo some.
    newMessage(env,'m2','Enviado por você',true);await env.service.tick();
    assert.equal((await env.contact()).aiDraft,null);
  } finally {await env.done();}
});

test('automático: com a chave geral desligada vira rascunho; ligada, envia uma única vez',async()=>{
  const off=await setup({mode:'auto',enabled:false});
  try {await off.service.tick();assert.equal(off.sent.length,0);assert.equal((await off.contact()).aiDraft.text,off.reply);}finally {await off.done();}
  const env=await setup({mode:'auto',enabled:true});
  try {
    await env.service.tick();await env.service.tick();
    assert.deepEqual(env.sent,[{to:jid,text:env.reply}]);
    const log=(await env.store.read()).assistant.log;assert.equal(log[0].action,'sent');
  } finally {await env.done();}
});

test('automático: ignora mensagens anteriores à classificação e contatos em modo desligado',async()=>{
  const old=await setup({mode:'auto',enabled:true,since:Date.now()+60_000});
  try {await old.service.tick();assert.equal(old.calls.length,0);assert.equal(old.sent.length,0);}finally {await old.done();}
  const off=await setup({mode:'off',enabled:true});
  try {await off.service.tick();assert.equal(off.calls.length,0);}finally {await off.done();}
});

test('automático: pedido de pessoa ou falta de resposta passa para atendente e não envia',async()=>{
  const env=await setup({mode:'auto',enabled:true});
  try {
    env.reply='[[HUMANO]]';await env.service.tick();
    const contact=await env.contact();
    assert.equal(env.sent.length,0);assert.equal(contact.status,'pending');assert.ok(contact.labels.includes('Atendente'));
  } finally {await env.done();}
});

test('automático: limite por contato e respeito a quem respondeu antes do envio',async()=>{
  const env=await setup({mode:'auto',enabled:true});
  try {
    await env.service.tick();assert.equal(env.sent.length,1);
    env.clock.t+=5000;newMessage(env,'m2','E o prazo?');await env.service.tick();
    assert.equal(env.sent.length,1,'Intervalo mínimo entre respostas automáticas.');
    assert.match((await env.contact()).aiDraft.text,/importação/);
  } finally {await env.done();}
  const race=await setup({mode:'auto',enabled:true});
  try {
    const original=race.service;
    // Alguém responde manualmente durante a geração da resposta.
    const slow=createAssistantService({store:race.store,client:{chats:async()=>race.chats,messages:async()=>({messages:race.messages}),sendText:async(to,text)=>{race.sent.push({to,text});}},ai:{config:async()=>({configured:true}),complete:async()=>{newMessage(race,'m9','Já respondi',true);return 'tarde demais';}},loadTexts:async()=>[],catalogText:async()=>CATALOG});
    await slow.tick();assert.equal(race.sent.length,0);assert.ok(original);
  } finally {await race.done();}
});

test('rotas: classificar contatos, editar regras, chave geral e PATCH do contato',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-assistant-http-'));
  const seen=[];
  const aiFetch=async(url,options)=>{seen.push(JSON.parse(options.body));return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'Temos importação da China, Europa e EUA e passagens.'}}]})};};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,aiFetch,assistantIntervalMs:3_600_000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token,Origin:base},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};};
  try {
    let state=(await call('/api/assistant')).body;
    assert.equal(state.enabled,false);assert.ok(state.rules.some(rule=>/Europa, China e EUA/.test(rule.title)));
    state=(await call('/api/assistant','PUT',{rules:[...state.rules,{title:'Garantia',text:'Fale da garantia somente se constar na base.'}]})).body;
    assert.equal(state.rules.at(-1).title,'Garantia');
    assert.equal((await call('/api/assistant','PUT',{rules:[{title:'',text:'x'}]})).status,422);
    state=(await call('/api/assistant','PUT',{enabled:true})).body;assert.equal(state.enabled,true);assert.ok(state.enabledSince);
    assert.equal((await call('/api/assistant','PUT',{enabled:'sim'})).status,422);
    assert.deepEqual((await call('/api/assistant/classify','POST',{jids:[jid],aiMode:'draft'})).body,{updated:1});
    assert.equal((await call('/api/assistant/classify','POST',{jids:['abc'],aiMode:'draft'})).status,422);
    assert.equal((await call('/api/assistant/classify','POST',{jids:[jid],aiMode:'tudo'})).status,422);
    let contact=(await call('/api/contact?jid='+encodeURIComponent(jid))).body;assert.equal(contact.aiMode,'draft');assert.ok(contact.aiSince);
    contact=(await call('/api/contact?jid='+encodeURIComponent(jid),'PATCH',{aiMode:'auto'})).body;assert.equal(contact.aiMode,'auto');
    assert.equal((await call('/api/contact?jid='+encodeURIComponent(jid),'PATCH',{aiMode:'x'})).status,422);
    contact=(await call('/api/contact?jid='+encodeURIComponent(jid),'PATCH',{aiMode:'off'})).body;assert.equal(contact.aiMode,'off');
    assert.equal((await call('/api/assistant')).body.counts.auto,0);
    // A pergunta na base usa regras editadas e o catálogo cadastrado.
    await call('/api/ai','PUT',{provider:'openai',model:'m',apiKey:'k'});
    await call('/api/products','POST',{name:'Importação de produtos da Europa',kind:'servico',category:'Importação de produtos'});
    const asked=(await call('/api/kb/ask','POST',{question:'Quais serviços vocês têm?'})).body;
    assert.match(asked.answer,/importação da China/);
    const system=seen.at(-1).messages[0].content;
    assert.match(system,/Garantia: Fale da garantia/);assert.match(system,/\[Importação de produtos\] Importação de produtos da Europa \(valor sob consulta\)/);
  } finally {await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});

test('applyMode: só marca o início ao ligar e limpa o rascunho ao desligar',()=>{
  const contact={aiDraft:{text:'x'}};
  applyMode(contact,'draft','2026-10-29T10:00:00.000Z');assert.equal(contact.aiSince,'2026-10-29T10:00:00.000Z');
  applyMode(contact,'draft','2026-10-29T11:00:00.000Z');assert.equal(contact.aiSince,'2026-10-29T10:00:00.000Z');
  applyMode(contact,'off');assert.equal(contact.aiDraft,null);
  assert.throws(()=>applyMode(contact,'x'),/Modo de IA inválido/);
});

async function audienceFixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-audience-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-29T12:00:00Z'),chats=[],records=[];const sent=[],calls=[],store=createStore(dir);
  const client={chats:async()=>chats,messages:async()=>({messages:records,pages:1}),sendText:async(to,text)=>{sent.push({to,text});return {id:'sent-'+sent.length};}};
  const ai={config:async()=>({configured:true}),complete:async options=>{calls.push(options);return 'Como posso ajudar?';}};
  const service=createAssistantService({store,client,ai,loadTexts:async()=>[],catalogText:async()=>'',now:()=>clock});t.after(()=>service.stop());
  const put=body=>service.handle({method:'PUT'},'/api/assistant',null,async()=>body);
  return {store,client,ai,service,sent,calls,put,now:()=>clock,advance:ms=>{clock+=ms;},receive:(id='fresh',timestamp=clock)=>{const message={id,jid,timestamp,fromMe:false,type:'text',text:'Olá',key:{id,remoteJid:jid,fromMe:false}};records.unshift(message);chats=[{jid,lastMessage:message}];return message;},seed:list=>{records=list;chats=[{jid,lastMessage:list[0]}];}};
}
test('público: todas as pessoas responde contato não classificado sem alterar seu modo ou início histórico',async t=>{
  const f=await audienceFixture(t);await f.store.update(data=>{data.contacts[jid]={notes:[{text:'preservar'}],aiSince:'2020-01-01T00:00:00Z'};});
  const view=await f.put({enabled:true,audience:'all'});assert.equal(view.body.audience,'all');f.advance(1000);f.receive();await f.service.tick();assert.equal(f.sent.length,1);
  const contact=(await f.store.read()).contacts[jid];assert.equal(contact.aiMode,undefined);assert.equal(contact.aiSince,'2020-01-01T00:00:00Z');assert.deepEqual(contact.notes,[{text:'preservar'}]);
  await assert.rejects(f.put({audience:'everyone'}),error=>error.status===422);
});
test('público novo: agenda não conta como conversa e contato novo continua atendido nas próximas mensagens',async t=>{
  const f=await audienceFixture(t);await f.store.update(data=>{data.contacts[jid]={name:'Contato salvo'};});await f.put({enabled:true,audience:'new'});f.advance(1000);f.receive();await f.service.tick();assert.equal(f.sent.length,1);
  f.advance(61000);f.receive('return');await f.service.tick();assert.equal(f.sent.length,2);
  const existing=await audienceFixture(t);existing.seed([{id:'old',type:'text',text:'Já conversamos',fromMe:true,timestamp:existing.now()-86400000}]);await existing.put({enabled:true,audience:'new'});existing.advance(1000);existing.receive();await existing.service.tick();assert.equal(existing.sent.length,0);
});
test('novos contatos mantêm inscrição após reinício e reativação; mudar o público inicia nova seleção',async t=>{
  const f=await audienceFixture(t);await f.put({enabled:true,audience:'new'});f.advance(1000);f.receive();await f.service.tick();assert.equal(f.sent.length,1);
  f.advance(61000);const restart=createAssistantService({store:f.store,client:f.client,ai:f.ai,loadTexts:async()=>[],catalogText:async()=>'',now:f.now});t.after(()=>restart.stop());f.advance(1000);f.receive('after-restart');await restart.tick();assert.equal(f.sent.length,2);
  await f.put({enabled:false});f.advance(1000);await f.put({enabled:true});f.advance(61000);f.receive('after-reactivate');await restart.tick();assert.equal(f.sent.length,3);
  await f.put({audience:'all'});await f.put({audience:'new'});f.advance(61000);f.receive('now-existing');await restart.tick();assert.equal(f.sent.length,3);
});
test('público amplo honra desligado explícito e pausa individual',async t=>{
  const f=await audienceFixture(t);await f.put({enabled:true,audience:'all'});await f.store.update(data=>{data.contacts[jid]={aiMode:'off'};});f.advance(1000);f.receive();await f.service.tick();assert.equal(f.sent.length,0);
  await f.store.update(data=>{data.contacts[jid]={automationPaused:true};});f.advance(1000);f.receive('paused');await f.service.tick();assert.equal(f.sent.length,0);
});
test('público amplo ignora mensagens anteriores à ativação, ao reinício e antigas mais de quinze minutos',async t=>{
  const f=await audienceFixture(t);f.receive('before',f.now()-1000);await f.put({enabled:true,audience:'all'});await f.service.tick();assert.equal(f.calls.length,0);
  f.advance(1000);f.receive('while-offline');const restart=createAssistantService({store:f.store,client:f.client,ai:f.ai,loadTexts:async()=>[],catalogText:async()=>'',now:f.now});await restart.tick();assert.equal(f.calls.length,0);restart.stop();
  f.advance(1000);f.receive('too-old');f.advance(16*60000);await f.service.tick();assert.equal(f.calls.length,0);
});
test('desligamento, pausa e mudança de público durante consulta final cancelam resposta já gerada',async t=>{
  for(const change of ['disable','pause','audience']) {
    const f=await audienceFixture(t);await f.put({enabled:true,audience:'all'});f.advance(1000);f.receive();f.ai.complete=async()=>{if(change==='disable') await f.put({enabled:false});else if(change==='audience') await f.put({audience:'new'});else await f.store.update(data=>{data.contacts[jid]={automationPaused:true};});return 'Resposta tardia';};await f.service.tick();assert.equal(f.sent.length,0,change);
  }
});
test('reserva compartilhada bloqueia IA quando outro robô já assumiu a entrada',async t=>{
  const f=await audienceFixture(t);await f.put({enabled:true,audience:'all'});f.advance(1000);const message=f.receive();const {claimKey}=require('../lib/triggers.cjs');await f.store.update(data=>{data.replyClaims={[claimKey(jid,message.id)]:{owner:'triggers',status:'queued'}};});await f.service.tick();assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});
test('IA cancela texto editado no mesmo identificador durante geração e respeita desligado no alias',async t=>{
  const f=await audienceFixture(t);await f.put({enabled:true,audience:'all'});f.advance(1000);const message=f.receive();f.ai.complete=async()=>{f.seed([{...message,text:'Já resolvi'}]);return 'Resposta antiga';};await f.service.tick();assert.equal(f.sent.length,0);
  const other=await audienceFixture(t),alias='123456789012345@lid';await other.put({enabled:true,audience:'all'});await other.store.update(data=>{data.contacts[alias]={aiMode:'off'};});other.advance(1000);const latest=other.receive();other.client.chats=async()=>[{jid,aliasJids:[alias],lastMessage:latest}];await other.service.tick();assert.equal(other.sent.length,0);
});
test('contato classificado não recebe resposta retroativa ao iniciar o aplicativo',async t=>{
  const f=await audienceFixture(t);await f.store.update(data=>{data.contacts[jid]={aiMode:'auto',aiSince:new Date(f.now()-3600000).toISOString()};data.assistant={enabled:true,enabledSince:new Date(f.now()-3600000).toISOString()};});f.receive('before-start',f.now()-60000);await f.service.tick();assert.equal(f.calls.length,0);
});
test('mesma entrada em telefone e LID reserva todos os aliases e gera uma única resposta',async t=>{
  const f=await audienceFixture(t),alias='123456789012345@lid';await f.put({enabled:true,audience:'all'});f.advance(1000);const message=f.receive();
  const adapted=target=>({...message,jid:target,key:{...message.key,remoteJid:target}});f.client.chats=async()=>[{jid,aliasJids:[alias],lastMessage:adapted(jid)},{jid:alias,aliasJids:[jid],lastMessage:adapted(alias)}];f.client.messages=async target=>({messages:[adapted(target)],pages:1});await f.service.tick();assert.equal(f.sent.length,1);assert.equal(f.calls.length,1);
  const {claimKey}=require('../lib/triggers.cjs'),claims=(await f.store.read()).replyClaims;assert.equal(claims[claimKey(jid,message.id)].status,'sent');assert.equal(claims[claimKey(alias,message.id)].status,'sent');
});
test('público novo aceita várias entradas da primeira conversa antes da consulta inicial',async t=>{
  const f=await audienceFixture(t);await f.put({enabled:true,audience:'new'});f.advance(1000);f.receive('first');f.advance(1000);f.receive('second');await f.service.tick();assert.equal(f.sent.length,1);assert.equal(f.calls.length,1);assert.match(f.calls[0].messages.at(-1).content,/Olá\nOlá/);assert.ok((await f.store.read()).assistant.enrolled[jid]);
});
