const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createEvolutionClient}=require('../lib/evolution.cjs');
const {createAutomationService}=require('../lib/automation.cjs');
const {createAssistantService}=require('../lib/assistant.cjs');
const {createHumanizer,normalizeHumanize,plan,DEFAULTS}=require('../lib/humanize.cjs');
const {createWhatsAppServer}=require('../server.cjs');

const jid='5511998765432@s.whatsapp.net';

test('plano: espera aleatória dentro do intervalo e "digitando" proporcional ao texto, com mínimo e teto',()=>{
  const config={...DEFAULTS,readMinSeconds:3,readMaxSeconds:10,typingMinMsPerChar:40,typingMaxMsPerChar:60,maxTypingSeconds:15};
  assert.deepEqual(plan('x'.repeat(100),config,()=>0),{waitMs:3000,typingMs:4000});
  assert.deepEqual(plan('x'.repeat(100),config,()=>1),{waitMs:10000,typingMs:6000});
  assert.equal(plan('oi',config,()=>0).typingMs,1200,'Mensagem curta ainda mostra digitando por um instante.');
  assert.equal(plan('x'.repeat(5000),config,()=>1).typingMs,15000,'Texto longo respeita o teto.');
  assert.deepEqual(plan('texto',{...config,typing:false,randomDelay:false},()=>0.5),{waitMs:0,typingMs:0});
  const waits=new Set(Array.from({length:20},()=>plan('texto',config).waitMs));
  assert.ok(waits.size>1,'Valores diferentes a cada resposta.');
  for(const wait of waits) assert.ok(wait>=3000 && wait<=10000);
});

test('configuração: valida limites, mínimo menor que máximo e grava na central',async()=>{
  assert.deepEqual(normalizeHumanize({}),DEFAULTS);
  assert.throws(()=>normalizeHumanize({readMinSeconds:12,readMaxSeconds:5}),/espera mínima/);
  assert.throws(()=>normalizeHumanize({typingMinMsPerChar:90,typingMaxMsPerChar:40}),/digitação mínima/);
  assert.throws(()=>normalizeHumanize({readMaxSeconds:500}),/entre 0 e 120/);
  assert.throws(()=>normalizeHumanize({typing:'sim'}),/inválida/);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-human-'));
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,humanize:true,assistantIntervalMs:3_600_000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token,Origin:base},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};};
  try {
    assert.deepEqual((await call('/api/humanize')).body,DEFAULTS);
    const saved=await call('/api/humanize','PUT',{...DEFAULTS,readMinSeconds:5,readMaxSeconds:15,typing:false});
    assert.equal(saved.body.readMaxSeconds,15);assert.equal(saved.body.typing,false);
    assert.equal((await call('/api/humanize')).body.readMinSeconds,5);
    assert.equal((await call('/api/humanize','PUT',{readMinSeconds:20,readMaxSeconds:5})).status,422);
  } finally {await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});

test('envio: o campo delay liga o "digitando…" e o limite de tempo cobre a espera',async()=>{
  const calls=[];
  const client=createEvolutionClient({apiUrl:'http://127.0.0.1:8767',apiKey:'test-only',instanceName:'test'},async(url,options)=>{
    calls.push({route:new URL(url).pathname,input:JSON.parse(options.body)});
    return Response.json({key:{id:'wamid',remoteJid:jid,fromMe:true},message:{conversation:'oi'},messageTimestamp:1793200000});
  });
  await client.sendText(jid,'manual');
  await client.sendText(jid,'automática',{delay:4321});
  await client.sendText(jid,'longa',{delay:999999});
  assert.equal('delay' in calls[0].input,false,'Mensagem manual não mostra digitando.');
  assert.equal(calls[1].input.delay,4321);assert.equal(calls[1].route,'/message/sendText/test');
  assert.equal(calls[2].input.delay,60000,'O tempo máximo é de 60 s.');
});

test('robô de palavras-chave: espera, mostra digitando e confere de novo depois da espera',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-human-bot-'));
  try {
    for(const scenario of ['normal','desligado-durante-a-espera']) {
      let clock=Date.parse('2026-10-28T12:00:00Z');const store=createStore(path.join(dir,scenario)),sent=[],sleeps=[];
      const record={id:'new',jid,timestamp:0,type:'text',fromMe:false,text:'Qual o preço?',key:{id:'new',remoteJid:jid,fromMe:false}};
      const client={chats:async()=>[{jid,name:'Ana'}],messages:async()=>({messages:[record],pages:1,page:1}),sendText:async(target,text,options)=>{sent.push({target,text,options});return {id:'r'};}};
      const humanizer={plan:async()=>({waitMs:6000,typingMs:2500}),sleep:async ms=>{sleeps.push(ms);if(scenario!=='normal') await service.saveSettings({enabled:false});}};
      var service=createAutomationService({store,client,now:()=>clock,humanizer});
      await service.saveSettings({enabled:true,rules:[{id:'preco',name:'Preço',keywords:['preço'],match:'word',response:'Posso ajudar com os valores.',enabled:true}]});
      clock+=1000;record.timestamp=clock;
      await service.tick();service.stop();
      assert.deepEqual(sleeps,[6000]);
      if(scenario==='normal') assert.deepEqual(sent,[{target:jid,text:'Posso ajudar com os valores.',options:{delay:2500}}]);
      else assert.equal(sent.length,0,'Se o robô foi desligado durante a espera, nada é enviado.');
    }
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('IA automática: espera, mostra digitando e não envia se alguém respondeu durante a espera',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-human-ai-'));
  try {
    for(const scenario of ['normal','respondeu-no-meio']) {
      const store=createStore(path.join(dir,scenario));
      await store.update(data=>{data.contacts[jid]={status:'open',labels:[],notes:[],aiMode:'auto',aiSince:new Date(Date.now()-60000).toISOString()};data.assistant={enabled:true,enabledSince:new Date(Date.now()-60000).toISOString()};});
      const inbound={id:'m1',fromMe:false,type:'text',text:'Vocês importam da China?',timestamp:Date.now()+1000};
      const state={last:inbound},sent=[],sleeps=[];
      const client={chats:async()=>[{jid,name:'Ana',lastMessage:state.last}],messages:async()=>({messages:[inbound]}),sendText:async(target,text,options)=>{sent.push({target,text,options});return {id:'r'};}};
      const ai={config:async()=>({configured:true}),complete:async()=>'Sim, fazemos importação da China.'};
      const humanizer={plan:async()=>({waitMs:7000,typingMs:3100}),sleep:async ms=>{sleeps.push(ms);if(scenario==='respondeu-no-meio') state.last={id:'m2',fromMe:true,type:'text',text:'Já respondi',timestamp:Date.now()};}};
      const service=createAssistantService({store,client,ai,loadTexts:async()=>[],catalogText:async()=>'',humanizer});
      await service.tick();
      assert.deepEqual(sleeps,[7000]);
      if(scenario==='normal') assert.deepEqual(sent,[{target:jid,text:'Sim, fazemos importação da China.',options:{delay:3100}}]);
      else assert.equal(sent.length,0);
    }
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('createHumanizer: lê a configuração gravada a cada resposta',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-human-store-'));
  try {
    const store=createStore(dir),humanizer=createHumanizer({store,random:()=>0});
    assert.equal((await humanizer.plan('x'.repeat(100))).waitMs,3000);
    await humanizer.save({...DEFAULTS,randomDelay:false});
    assert.equal((await humanizer.plan('x'.repeat(100))).waitMs,0);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('gatilhos: espera aleatória e "digitando…" antes do texto, com nova conferência depois da espera',async()=>{
  const {createTriggerService}=require('../lib/triggers.cjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-human-trigger-'));
  try {
    const store=createStore(dir);let clock=Date.parse('2026-10-29T12:00:00Z'),rows=[],records=[];const sent=[],sleeps=[];
    const client={chats:async()=>rows,messages:async(target)=>({messages:records.filter(item=>item.jid===target),pages:1}),sendText:async(to,text,options)=>{sent.push({to,text,options});return {id:'se'+sent.length};}};
    const humanizer={plan:async()=>({waitMs:6000,typingMs:2000}),sleep:async ms=>{sleeps.push(ms);}};
    const service=createTriggerService({store,client,now:()=>clock,humanizer});
    await service.saveSettings({enabled:true,rules:[{id:'price',name:'Preço',enabled:true,type:'keyword',keywords:['preço'],match:'word',delaySeconds:0,messages:[{type:'text',text:'Valores sob consulta.'}]}]});
    clock+=1000;
    const message={id:'new',jid,timestamp:clock,type:'text',text:'Qual o preço?',fromMe:false,key:{id:'new',remoteJid:jid,fromMe:false}};
    records.unshift(message);rows=[{jid,lastMessage:message}];
    await service.tick();service.stop();
    assert.deepEqual(sleeps,[6000]);
    assert.deepEqual(sent,[{to:jid,text:'Valores sob consulta.',options:{delay:2000}}]);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
