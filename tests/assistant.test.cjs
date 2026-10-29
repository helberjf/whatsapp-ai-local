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
    chats:[{jid,name:'Ana',lastMessage:{id:'m1',fromMe:false,type:'text',text:'Vocês importam da China?',timestamp:Date.now()}}],
    messages:[{id:'m1',fromMe:false,type:'text',text:'Vocês importam da China?',timestamp:Date.now()}]};
  const client={chats:async()=>env.chats,messages:async()=>({messages:env.messages}),sendText:async(to,text)=>{env.sent.push({to,text});return {id:'out-'+env.sent.length};}};
  const ai={config:async()=>({configured:true}),complete:async options=>{env.calls.push(options);return env.reply;}};
  env.service=createAssistantService({store,client,ai,loadTexts:async()=>[{id:'1',name:'importacao.md',text:'Importação de produtos da China com frete internacional e desembaraço.'}],catalogText:async()=>CATALOG,now:()=>env.clock.t});
  env.contact=async()=>(await store.read()).contacts[jid];
  env.done=()=>fs.rm(dir,{recursive:true,force:true});
  return env;
}
const newMessage=(env,id,text,fromMe=false)=>{const message={id,fromMe,type:'text',text,timestamp:Date.now()};env.messages.push(message);env.chats[0].lastMessage=message;};

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
