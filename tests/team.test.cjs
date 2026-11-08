const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createTeamService,normalizeSettings,SURVEY_OPTIONS,dayKey}=require('../lib/team.cjs');
const {claimKeys,identities}=require('../lib/triggers.cjs');
const {createWhatsAppServer}=require('../server.cjs');

const jidOf=i=>'55119'+String(i).padStart(8,'0')+'@s.whatsapp.net';
// Conversas, IA e relógio controlados pelo teste; nada sai deste processo.
async function setup(t,{ai}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-team-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(dir),clock={t:Date.parse('2026-11-04T13:00:00')},env={store,clock,sent:[],polls:[],chats:[],messages:new Map()};
  const client={
    chats:async()=>env.chats,messages:async jid=>({messages:env.messages.get(jid) || []}),
    sendText:async(jid,text)=>{env.sent.push({jid,text});const message={id:'out-'+env.sent.length,jid,fromMe:true,type:'text',text,timestamp:clock.t};env.set(jid,message);return message;},
    sendPoll:async(jid,input)=>{env.polls.push({jid,...input});return {id:'poll-'+env.polls.length,jid,fromMe:true,type:'poll'};}
  };
  env.ai={config:async()=>({configured:true}),complete:ai || (async()=>'{"categoria":"Suporte"}')};
  env.team=createTeamService({store,client,ai:env.ai,now:()=>clock.t});env.team.start();
  env.set=(jid,message)=>{let chat=env.chats.find(item=>item.jid===jid);if(!chat) env.chats.push(chat={jid,name:'Cliente',lastMessage:null});chat.lastMessage=message;env.messages.set(jid,[...(env.messages.get(jid) || []),message]);};
  env.customer=(i,text='Olá, qual o prazo?',type='text')=>{clock.t+=1000;const message={id:'in-'+i+'-'+clock.t,jid:jidOf(i),fromMe:false,type,text,timestamp:clock.t};env.set(jidOf(i),message);return message;};
  env.reply=(i,text='Já vou ver!')=>{clock.t+=1000;const message={id:'me-'+i+'-'+clock.t,jid:jidOf(i),fromMe:true,type:'text',text,timestamp:clock.t};env.set(jidOf(i),message);return message;};
  env.day=async()=>(await store.read()).team.days[dayKey(clock.t)];
  return env;
}

test('fila: abre na mensagem do cliente, fecha na resposta e separa IA/robôs de pessoas',async t=>{
  const env=await setup(t);
  await env.store.update(data=>{data.team={settings:{members:[{id:'ana',name:'Ana'}]}};data.contacts[jidOf(2)]={status:'open',labels:[],notes:[],assignee:'ana'};});
  const first=env.customer(1);env.customer(2);env.customer(3,'👍','reaction');env.customer(4,'Ótimo','poll_vote');
  await env.team.tick();
  assert.deepEqual(Object.keys(await env.team.waiting()).sort(),[jidOf(1),jidOf(2)],'reação e voto não abrem espera');
  // A resposta do cliente 1 saiu por um robô (reserva enviada); a do cliente 2, por uma pessoa.
  await env.store.update(data=>{data.replyClaims={};for(const key of claimKeys(identities({jid:jidOf(1)}),first.id)) data.replyClaims[key]={owner:'assistant',status:'sent'};});
  env.clock.t+=4*60_000;env.reply(1);env.clock.t+=16*60_000;env.reply(2);
  await env.team.tick();
  assert.deepEqual(await env.team.waiting(),{});
  const day=await env.day();
  assert.equal(day.incoming,2);assert.equal(day.responses,2);assert.equal(day.auto,1);assert.equal(day.human,1);assert.equal(day.onTime,1);assert.equal(day.late,1);
  assert.equal(day.hours[new Date(first.timestamp).getHours()],2);assert.equal(day.members.ana.responses,1);
  const summary=(await env.team.handle({method:'GET'},'/api/team/metrics',new URL('http://x/?days=7'))).body;
  assert.equal(summary.totals.incoming,2);assert.equal(summary.totals.auto,1);assert.ok(summary.totals.averageResponseMs>4*60_000);assert.equal(summary.series.length,7);
  assert.equal(summary.members[0].responses,1);
});

test('fila: histórico anterior não entra nos números, conversa concluída sai da fila e o painel conta passagens',async t=>{
  const env=await setup(t);
  env.customer(1);env.team.start();env.clock.t+=60_000;
  await env.team.tick();assert.ok((await env.team.waiting())[jidOf(1)],'quem já esperava aparece na fila');
  assert.equal((await env.day()).incoming,0,'mas não conta como entrada nova');
  await env.store.update(data=>{data.contacts[jidOf(1)]={status:'closed',labels:[],notes:[]};data.assistant={log:[{at:new Date(env.clock.t+500).toISOString(),action:'handoff',jid:jidOf(1)},{at:new Date(env.clock.t+600).toISOString(),action:'unanswered',jid:jidOf(1)}]};});
  env.clock.t+=1000;await env.team.tick();
  assert.deepEqual(await env.team.waiting(),{});const day=await env.day();assert.equal(day.handoffs,1);assert.equal(day.unanswered,1);
  await env.team.tick();assert.equal((await env.day()).handoffs,1,'cada registro conta uma vez');
});

test('aviso de fila: posição e tempo, uma vez por espera, sem fechar a espera e nunca quando a IA vai responder',async t=>{
  const env=await setup(t);
  await env.store.update(data=>{data.team={settings:{queueNotice:{enabled:true,afterSeconds:60,cooldownHours:6,fallbackMinutes:5,text:'Você é o {posicao}º, tempo estimado {tempo}.'}}};data.contacts[jidOf(3)]={status:'open',labels:[],notes:[],aiMode:'auto'};data.assistant={enabled:true,audience:'classified'};});
  env.customer(1);env.customer(2);env.customer(3);await env.team.tick();assert.equal(env.sent.length,0,'antes do prazo não avisa');
  env.clock.t+=61_000;await env.team.tick();
  assert.deepEqual(env.sent.map(item=>[item.jid,item.text]),[[jidOf(1),'Você é o 1º, tempo estimado 5 min.'],[jidOf(2),'Você é o 2º, tempo estimado 10 min.']]);
  await env.team.tick();env.clock.t+=60_000;await env.team.tick();
  assert.equal(env.sent.length,2,'um aviso por espera');assert.ok((await env.team.waiting())[jidOf(1)],'o aviso não conta como resposta');
  assert.equal((await env.day()).notices,2);
  env.reply(1);await env.team.tick();assert.equal((await env.team.waiting())[jidOf(1)],undefined,'a resposta de verdade fecha a espera');
});

test('pesquisa ao concluir: enquete nativa uma vez por dia e voto entra na satisfação',async t=>{
  const env=await setup(t);
  await env.store.update(data=>{data.team={settings:{survey:{enabled:true,question:'Como foi?'}}};data.contacts[jidOf(1)]={status:'closed',labels:[],notes:[]};});
  const sent=await env.team.onStatus(jidOf(1),'open','closed',null);
  assert.equal(sent.id,'poll-1');assert.deepEqual(env.polls[0],{jid:jidOf(1),name:'Como foi?',options:SURVEY_OPTIONS,selectableCount:1});
  assert.equal(await env.team.onStatus(jidOf(1),'open','closed',null),null,'no máximo uma por dia');
  assert.equal(await env.team.onStatus(jidOf(1),'closed','closed',null),null);
  env.clock.t+=5000;env.set(jidOf(1),{id:'vote',jid:jidOf(1),fromMe:false,type:'poll_vote',text:'🙂 Bom',vote:{pollId:'poll-1',options:['🙂 Bom']},timestamp:env.clock.t});
  await env.team.tick();
  const contact=(await env.store.read()).contacts[jidOf(1)];assert.equal(contact.survey.answer,'🙂 Bom');
  const summary=env.team.summary(await env.store.read(),1);assert.deepEqual({sent:summary.surveys.sent,answered:summary.surveys.answered,satisfaction:summary.surveys.satisfaction},{sent:1,answered:1,satisfaction:100});
  assert.equal(summary.totals.closed,2,'cada conclusão (aberta → concluída) conta, mesmo sem nova pesquisa');
});

test('triagem: a IA escolhe um assunto cadastrado e a etiqueta substitui a anterior; resposta fora da lista é ignorada',async t=>{
  const asked=[];let reply='{"categoria":"suporte"}';
  const env=await setup(t,{ai:async options=>{asked.push(options);return reply;}});
  await env.store.update(data=>{data.team={settings:{triage:{enabled:true,categories:['Orçamento','Suporte'],labelPrefix:'Assunto: '}}};data.contacts[jidOf(1)]={status:'open',labels:['Cliente'],notes:[]};});
  env.customer(1,'Meu pedido chegou quebrado');env.customer(2,'Oi');
  await env.team.tick();await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual((await env.store.read()).contacts[jidOf(1)].labels,['Cliente','Assunto: Suporte']);
  assert.match(asked[0].system,/Orçamento; Suporte/);assert.match(asked[0].messages[0].content,/chegou quebrado/);assert.equal(asked[0].json,true);
  reply='{"categoria":"Viagem"}';env.clock.t+=2*86_400_000;env.customer(3,'Quero viajar');await env.team.tick();await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await env.store.read()).contacts[jidOf(3)]?.labels?.some(label=>label.startsWith('Assunto:')) || false,false);
});

test('configuração da equipe valida nomes, prazos e textos',()=>{
  const base=normalizeSettings({},{members:[],sla:{warnMinutes:5,lateMinutes:15},triage:{enabled:false,categories:['A','B'],labelPrefix:'Assunto: '},queueNotice:{enabled:false,afterSeconds:90,cooldownHours:6,fallbackMinutes:10,text:'x'},survey:{enabled:false,question:'q'}});
  assert.throws(()=>normalizeSettings({members:[{name:'Ana'},{name:'ana'}]},base),/nomes diferentes/);
  assert.throws(()=>normalizeSettings({sla:{warnMinutes:20,lateMinutes:10}},base),/menor/);
  assert.throws(()=>normalizeSettings({triage:{categories:['Só um']}},base),/2 a 12/);
  assert.throws(()=>normalizeSettings({queueNotice:{afterSeconds:5}},base),/30 a 3600/);
  assert.throws(()=>normalizeSettings({outra:1},base),/inválida/);
  const next=normalizeSettings({members:[{name:' Ana '},{name:'Bruno'}]},base);assert.deepEqual(next.members.map(member=>member.name),['Ana','Bruno']);assert.ok(next.members[0].id);assert.match(next.members[1].color,/^#/);
});

test('rotas: ações em massa, responsável validado e pesquisa ao concluir pelo PATCH do contato',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-team-http-'));
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};calls.push({route,input});
    if(route.includes('/findChats/')) return new Response(JSON.stringify([1,2].map(i=>({remoteJid:jidOf(i),pushName:'C'+i,lastMessage:{key:{id:'m'+i,remoteJid:jidOf(i),fromMe:false},message:{conversation:'Oi'},messageTimestamp:1793200000}}))));
    if(route.includes('/archiveChat/')) return new Response(JSON.stringify({chatId:input.chat,archived:true}));
    if(route.includes('/sendPoll/')) return new Response(JSON.stringify({key:{id:'poll-x',remoteJid:input.number,fromMe:true},message:{pollCreationMessage:{name:input.name,options:input.values.map(optionName=>({optionName}))}}}));
    return new Response(JSON.stringify(route.includes('/findContacts/')?[]:{}));
  };
  const credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,fetchImpl,credentials,disableWorkers:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};};
  const team=(await call('/api/team','PUT',{members:[{name:'Ana'}],survey:{enabled:true}})).body.settings,ana=team.members[0].id;
  assert.equal((await call('/api/contact?jid='+encodeURIComponent(jidOf(1)),'PATCH',{assignee:'nao-existe'})).status,422);
  assert.equal((await call('/api/contact?jid='+encodeURIComponent(jidOf(1)),'PATCH',{assignee:ana})).body.assignee,ana);
  const closed=(await call('/api/contact?jid='+encodeURIComponent(jidOf(1)),'PATCH',{status:'closed'})).body;assert.equal(closed.surveySent,true);
  assert.equal(calls.filter(item=>item.route.includes('/sendPoll/')).length,1);
  assert.deepEqual((await call('/api/chats/bulk','POST',{jids:[jidOf(1),jidOf(2)],action:'label',value:'VIP'})).body,{updated:2,failed:[]});
  assert.equal((await call('/api/chats/bulk','POST',{jids:[jidOf(2)],action:'assign',value:ana})).body.updated,1);
  assert.equal((await call('/api/chats/bulk','POST',{jids:[jidOf(2)],action:'archive'})).body.updated,1);
  assert.equal((await call('/api/chats/bulk','POST',{jids:[jidOf(2)],action:'apagar'})).status,422);
  assert.equal((await call('/api/chats/bulk','POST',{jids:[],action:'close'})).status,422);
  const contact=(await call('/api/contact?jid='+encodeURIComponent(jidOf(2)))).body;
  assert.deepEqual({labels:contact.labels,assignee:contact.assignee,archived:contact.archived},{labels:['VIP'],assignee:ana,archived:true});
  const metrics=(await call('/api/team/metrics?days=1')).body;assert.equal(metrics.totals.closed,1);assert.equal(metrics.surveys.sent,1);
  assert.equal((await call('/api/team/metrics?days=3')).status,422);
  await call('/api/team','PUT',{members:[]});assert.equal((await call('/api/contact?jid='+encodeURIComponent(jidOf(2)))).body.assignee,null,'atendente removido deixa as conversas sem responsável');
});

test('fila: abrir a conversa tira da fila, resposta pelo outro identificador fecha, e a opção pode ser desligada',async t=>{
  const env=await setup(t);
  const seen=env.customer(1);env.customer(2);env.customer(3);await env.team.tick();
  assert.equal(Object.keys(await env.team.waiting()).length,3);
  // Cliente 1: aberto na central (mesmo já lido no celular).
  await env.store.update(data=>{data.contacts[jidOf(1)]={status:'open',labels:[],notes:[],readState:{messageIds:[],lastSeenId:seen.id,seenAt:env.clock.t}};});
  // Cliente 2: a mesma pessoa aparece também como @lid, e a resposta saiu por lá.
  const lid='222222222222222@lid';env.chats.find(chat=>chat.jid===jidOf(2)).aliasJids=[lid];env.clock.t+=1000;env.chats.push({jid:lid,aliasJids:[jidOf(2)],name:'Cliente',lastMessage:{id:'me-lid',jid:lid,fromMe:true,type:'text',text:'Oi!',timestamp:env.clock.t}});
  await env.team.tick();
  assert.deepEqual(Object.keys(await env.team.waiting()),[jidOf(3)],'vista e resposta pelo @lid saem da fila');
  assert.equal((await env.day()).responses,0,'tirar da fila por abrir não conta como resposta');
  env.customer(1,'Mais uma pergunta');await env.team.tick();assert.ok((await env.team.waiting())[jidOf(1)],'mensagem nova depois de abrir volta para a fila');
  await env.store.update(data=>{data.team.settings={...data.team.settings,sla:{warnMinutes:5,lateMinutes:15,clearOnView:false}};data.team.waiting={};});
  const again=env.customer(4);await env.store.update(data=>{data.contacts[jidOf(4)]={status:'open',labels:[],notes:[],readState:{messageIds:[],lastSeenId:again.id,seenAt:env.clock.t}};});
  await env.team.tick();assert.ok((await env.team.waiting())[jidOf(4)],'com a opção desligada, só a resposta tira da fila');
  assert.equal(normalizeSettings({sla:{warnMinutes:5,lateMinutes:15,clearOnView:false}},normalizeSettings({},{sla:{warnMinutes:5,lateMinutes:15}})).sla.clearOnView,false);
  assert.throws(()=>normalizeSettings({sla:{warnMinutes:5,lateMinutes:15,clearOnView:'sim'}},normalizeSettings({},{sla:{warnMinutes:5,lateMinutes:15}})),/inválida/);
});

test('rotas: abrir conversa já lida registra a vista e "marcar como lida" em massa tira da fila',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-team-view-')),reads=[];
  const fetchImpl=async(url,options={})=>{const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};
    if(route.includes('/findChats/')) return new Response(JSON.stringify([1,2].map(i=>({remoteJid:jidOf(i),pushName:'C'+i,lastMessage:{key:{id:'m'+i,remoteJid:jidOf(i),fromMe:false},message:{conversation:'Oi'},messageTimestamp:1793200000}}))));
    if(route.includes('/markMessageAsRead/')) {reads.push(input);return new Response('{}');}
    return new Response(JSON.stringify(route.includes('/findContacts/')?[]:{}));};
  await createStore(dir).update(data=>{data.team={waiting:{[jidOf(1)]:{since:1,messageId:'m1',lastId:'m1'},[jidOf(2)]:{since:1,messageId:'m2',lastId:'m2'}}};});
  const credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,fetchImpl,credentials,disableWorkers:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};};
  assert.equal((await call('/api/read','POST',{jid:jidOf(1),keys:[],lastSeenId:'m1'})).status,200);assert.equal(reads.length,0,'sem confirmar leitura de novo no WhatsApp');
  let chats=(await call('/api/chats')).body;assert.equal(chats.find(chat=>chat.jid===jidOf(1)).waitingSince,undefined);assert.equal(chats.find(chat=>chat.jid===jidOf(2)).waitingSince,1);
  assert.equal((await call('/api/chats/bulk','POST',{jids:[jidOf(2)],action:'read'})).body.updated,1);
  chats=(await call('/api/chats')).body;assert.equal(chats.find(chat=>chat.jid===jidOf(2)).waitingSince,undefined);
});
