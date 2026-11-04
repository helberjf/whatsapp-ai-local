const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createAssistantService,NO_REPLY}=require('../lib/assistant.cjs');
const {createLimiter,createBackground}=require('../lib/concurrency.cjs');

const jidOf=i=>'55119'+String(i).padStart(8,'0')+'@s.whatsapp.net';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

// Vários clientes, IA controlada pelo teste e relógio manual. Nenhuma mensagem sai do processo.
async function setup(t,{customers=3,concurrency=4,reply=async()=>'Claro, posso ajudar.'}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-volume-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(dir),clock={t:Date.now()},since=new Date(clock.t-60_000).toISOString();
  await store.update(data=>{data.assistant={enabled:true,enabledSince:since,audience:'classified'};for(let i=0;i<customers;i++) data.contacts[jidOf(i)]={status:'open',labels:['Cliente'],notes:[],aiMode:'auto',aiSince:since};});
  const env={store,clock,sent:[],calls:0,active:0,peak:0,chats:[]};
  const client={chats:async()=>env.chats,messages:async jid=>({messages:env.chats.find(chat=>chat.jid===jid)?.messages || []}),
    sendText:async(jid,text)=>{env.sent.push({jid,text});const chat=env.chats.find(item=>item.jid===jid),message={id:'out-'+env.sent.length,jid,fromMe:true,type:'text',text,timestamp:clock.t,key:{id:'out-'+env.sent.length,remoteJid:jid,fromMe:true}};chat.messages.push(message);chat.lastMessage=message;return message;}};
  const ai={config:async()=>({configured:true}),complete:async options=>{env.calls++;env.active++;env.peak=Math.max(env.peak,env.active);try {return await reply(options,env);}finally {env.active--;}}};
  env.service=createAssistantService({store,client,ai,loadTexts:async()=>[],catalogText:async()=>'',now:()=>clock.t,concurrency});
  env.service.start({poll:false});clock.t+=5000;
  env.receive=(i,text='Qual o prazo?')=>{clock.t+=1000;const jid=jidOf(i),message={id:'in-'+i+'-'+clock.t,jid,fromMe:false,type:'text',text,timestamp:clock.t,key:{id:'in-'+i+'-'+clock.t,remoteJid:jid,fromMe:false}};let chat=env.chats.find(item=>item.jid===jid);if(!chat) env.chats.push(chat={jid,name:'Cliente '+i,messages:[]});chat.messages.push(message);chat.lastMessage=message;return message;};
  env.contact=async i=>(await store.read()).contacts[jidOf(i)];
  t.after(()=>env.service.stop());
  return env;
}

test('limitador e fila por contato: no máximo N juntos e uma tarefa por chave',async()=>{
  const limiter=createLimiter(2),gates=[deferred(),deferred(),deferred()];let active=0,peak=0;
  const runs=gates.map(gate=>limiter.run(async()=>{active++;peak=Math.max(peak,active);await gate.promise;active--;}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(limiter.active,2);assert.equal(limiter.waiting,1);
  for(const gate of gates) gate.resolve();await Promise.all(runs);assert.equal(peak,2);
  const background=createBackground(),order=[],gate=deferred();
  assert.equal(background.dispatch('a',async()=>{await gate.promise;order.push('a1');}),true);
  assert.equal(background.dispatch('a',()=>order.push('duplicada')),false);
  background.chain('a',()=>order.push('a2'));background.dispatch('b',()=>order.push('b'));
  gate.resolve();await background.idle();assert.deepEqual(order,['b','a1','a2']);assert.equal(background.size,0);
});

test('várias conversas são geradas ao mesmo tempo, respeitando o limite de IA',async t=>{
  const release=deferred();
  const env=await setup(t,{customers:6,concurrency:3,reply:async()=>{await release.promise;return 'Resposta pronta.';}});
  for(let i=0;i<6;i++) env.receive(i);
  const tick=env.service.tick();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(env.active,3,'três gerações em paralelo');assert.equal(env.service.load().ai.waiting,3);
  release.resolve();await tick;
  assert.equal(env.peak,3);assert.equal(env.sent.length,6);assert.equal(env.calls,6);
  await env.service.tick();assert.equal(env.calls,6,'nenhuma mensagem é tratada duas vezes');
});

test('mensagem que perde o prazo na fila vira Pendente com "Sem resposta" e registro',async t=>{
  const slow=deferred();
  const env=await setup(t,{customers:2,concurrency:1,reply:async(options,state)=>{if(state.calls===1) {await slow.promise;state.clock.t+=16*60_000;}return 'Resposta.';}});
  env.receive(0);env.receive(1);
  const tick=env.service.tick();await new Promise(resolve=>setTimeout(resolve,30));
  slow.resolve();await tick;
  const marked=[await env.contact(0),await env.contact(1)];
  for(const contact of marked) {assert.equal(contact.status,'pending');assert.ok(contact.labels.includes(NO_REPLY));assert.ok(contact.labels.includes('Cliente'));}
  assert.equal(env.sent.length,0,'nada é enviado fora do prazo');
  const log=(await env.store.read()).assistant.log;assert.equal(log.filter(entry=>entry.action==='unanswered').length,2);
  // Quando o atendente responde, a marca sai e o status fica como você deixou.
  await env.service.tick();await env.store.update(data=>{});
  const chat=env.chats[0];chat.lastMessage={id:'manual',jid:chat.jid,fromMe:true,type:'text',text:'Oi! Já vou te ajudar.',timestamp:env.clock.t,key:{id:'manual',remoteJid:chat.jid,fromMe:true}};
  await env.service.tick();const after=await env.contact(0);assert.equal(after.labels.includes(NO_REPLY),false);assert.equal(after.status,'pending');
});

test('mensagem antiga chegada depois da ativação, sem resposta a tempo, é marcada uma única vez',async t=>{
  const env=await setup(t,{customers:1});
  env.receive(0);env.clock.t+=20*60_000;
  await env.service.tick();await env.service.tick();
  assert.equal(env.calls,0);const contact=await env.contact(0);assert.ok(contact.labels.includes(NO_REPLY));
  assert.equal((await env.store.read()).assistant.log.filter(entry=>entry.action==='unanswered').length,1);
});

test('falha da IA em modo automático não deixa o cliente esperando sem aviso; em rascunho só registra',async t=>{
  const env=await setup(t,{customers:2,reply:async()=>{throw new Error('provedor fora do ar');}});
  await env.store.update(data=>{data.contacts[jidOf(1)].aiMode='draft';});
  env.receive(0);env.receive(1);await env.service.tick();
  assert.ok((await env.contact(0)).labels.includes(NO_REPLY));assert.equal((await env.contact(0)).status,'pending');
  assert.equal((await env.contact(1)).labels.includes(NO_REPLY),false);assert.equal((await env.contact(1)).status,'open');
  const actions=(await env.store.read()).assistant.log.map(entry=>entry.action).sort();assert.deepEqual(actions,['error','unanswered']);
});

test('mensagens anteriores à ativação continuam fora: não viram campanha nem pendência',async t=>{
  const env=await setup(t,{customers:1});
  const chat={jid:jidOf(0),name:'Cliente 0',messages:[]};env.chats.push(chat);
  const old={id:'old',jid:chat.jid,fromMe:false,type:'text',text:'Mensagem de ontem',timestamp:env.clock.t-86400_000,key:{id:'old',remoteJid:chat.jid,fromMe:false}};
  chat.messages.push(old);chat.lastMessage=old;
  await env.service.tick();
  assert.equal(env.calls,0);const contact=await env.contact(0);assert.equal(contact.status,'open');assert.equal(contact.labels.includes(NO_REPLY),false);
});
