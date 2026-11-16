const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createSalesService,pixCode,crc16,normalizeKey,parseAmount,parse}=require('../lib/sales.cjs');
const {createAssistantService}=require('../lib/assistant.cjs');
const jid='5511998765432@s.whatsapp.net';
// Segunda-feira, 16/11/2026, 10:00 em São Paulo.
const START=Date.parse('2026-11-16T13:00:00Z');
const CATALOG=[{name:'Site',price:1500,discountPercent:0,active:true},{name:'Logo',price:200,discountPercent:10,active:true},{name:'Sistema',price:null,active:true}];
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-sales-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(dir),sent=[],time={value:START};
  const client={sendText:async(to,text)=>{sent.push({type:'text',to,text});return {id:'s'+sent.length};},sendMedia:async(to,input)=>{sent.push({type:'media',to,...input});return {id:'s'+sent.length};}};
  const sales=createSalesService({store,client,products:async()=>CATALOG,now:()=>time.value});
  return {store,client,sales,sent,time,advance:ms=>{time.value+=ms;}};
}
const pix={enabled:true,keyType:'email',key:'Vendas@Exemplo.com',name:'João da Silva',city:'São Paulo'};

test('código Pix segue o padrão do Banco Central, com CRC conferido',()=>{
  assert.equal(crc16('123456789'),'29B1');
  const code=pixCode({key:'123e4567-e12b-12d1-a456-426655440000',name:'Fulano de Tal',city:'BRASILIA',amount:null,txid:'***'});
  assert.equal(code,'00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913FULANO DE TAL6008BRASILIA62070503***6304'+crc16(code.slice(0,-4)));
  const paid=pixCode({key:'+5511999998888',name:'João da Silva',city:'São Paulo',amount:1350,txid:'WA1'});
  assert.match(paid,/54071350\.005802BR5913JOAO DA SILVA6009SAO PAULO62070503WA16304[0-9A-F]{4}$/);
  assert.equal(normalizeKey('phone','(11) 99999-8888'),'+5511999998888');assert.equal(normalizeKey('phone','+55 11 99999-8888'),'+5511999998888');
  assert.equal(normalizeKey('cpf','123.456.789-09'),'12345678909');assert.throws(()=>normalizeKey('cnpj','123'),error=>error.status===422);
  assert.deepEqual(['199,90','R$ 1.234,56','199.90','1.500','abc'].map(parseAmount),[199.9,1234.56,199.9,1500,null]);
});
test('vendas começam desligadas e só ligam com a configuração completa',async t=>{
  const f=await fixture(t),view=await f.sales.view();
  assert.deepEqual([view.qualify.enabled,view.agenda.enabled,view.pix.enabled,view.contract.enabled],[false,false,false,false]);assert.equal(await f.sales.prompt(),'');
  await assert.rejects(f.sales.save({pix:{enabled:true}}),error=>error.status===422);
  await assert.rejects(f.sales.save({contract:{enabled:true}}),error=>error.status===422);
  await assert.rejects(f.sales.save({contract:{link:'http://inseguro.example'}}),error=>error.status===422);
  await assert.rejects(f.sales.save({agenda:{start:'18:00',end:'09:00'}}),error=>error.status===422);
  await assert.rejects(f.sales.save({other:true}),error=>error.status===422);
  const saved=await f.sales.save({pix,contract:{enabled:true,file:{base64:'JVBERg==',mimeType:'application/pdf',fileName:'contrato.pdf'}}});
  assert.equal(saved.pix.key,'vendas@exemplo.com');assert.deepEqual(saved.contract.file,{fileName:'contrato.pdf',mimeType:'application/pdf',bytes:4});
  assert.match(await f.sales.prompt(),/\[\[PIX: valor\]\][\s\S]*\[\[CONTRATO\]\]/);
});
test('marcações saem do texto e viram ações',()=>{
  assert.deepEqual(parse('Perfeito, estou enviando o código.\n[[PIX: 199,90]]\n[[lead: quer um site]]'),{text:'Perfeito, estou enviando o código.',actions:[{kind:'pix',value:'199,90'},{kind:'lead',value:'quer um site'}]});
  assert.deepEqual(parse('Sem ações.'),{text:'Sem ações.',actions:[]});
});
test('Pix só sai com valor do catálogo e respeita o limite por contato',async t=>{
  const f=await fixture(t);await f.sales.save({pix});
  assert.match((await f.sales.plan(jid,[{kind:'pix',value:'999,00'}])).problem,/catálogo/);
  assert.match((await f.sales.plan(jid,[{kind:'contrato',value:''}])).problem,/desligado/);
  const planned=await f.sales.plan(jid,[{kind:'pix',value:'R$ 180,00'}]);assert.deepEqual(planned.steps,[{kind:'pix',amount:180}]);
  assert.deepEqual(await f.sales.execute(jid,planned.steps),['Pix de R$ 180,00 enviado']);
  assert.equal(f.sent.length,2);assert.match(f.sent[0].text,/Pix de R\$ 180,00 para João da Silva/);assert.match(f.sent[1].text,/^000201.*5406180\.00.*6304[0-9A-F]{4}$/);
  const contact=(await f.store.read()).contacts[jid];assert.equal(contact.crm.stage,'negotiating');assert.ok(contact.labels.includes('Pix enviado'));assert.equal(contact.status,'pending');
  for(let i=0;i<2;i++) await f.sales.execute(jid,[{kind:'pix',amount:180}]);
  assert.match((await f.sales.plan(jid,[{kind:'pix',value:'180'}])).problem,/Limite/);
  f.advance(3600_001);assert.ok((await f.sales.plan(jid,[{kind:'pix',value:'180'}])).steps);
});
test('agenda oferece só horários livres, marca, remarca e libera ao cancelar',async t=>{
  const f=await fixture(t);await f.sales.save({agenda:{enabled:true,subject:'uma reunião de apresentação',slotMinutes:60,note:'Link: https://meet.example/sala'}});
  const prompt=await f.sales.prompt();assert.match(prompt,/2026-11-16 12:00 → segunda-feira, 16\/11 às 12:00/);assert.doesNotMatch(prompt,/2026-11-16 11:00/);assert.doesNotMatch(prompt,/2026-11-21/);
  assert.match((await f.sales.plan(jid,[{kind:'agendar',value:'2026-11-21 10:00'}])).problem,/não é um horário livre/);
  const planned=await f.sales.plan(jid,[{kind:'agendar',value:'2026-11-17T14:00'}]);
  assert.deepEqual(await f.sales.execute(jid,planned.steps,{name:'Ana'}),['reunião agendada']);
  assert.equal(f.sent.at(-1).text,'✅ Agendado: terça-feira, 17/11 às 14:00.\nLink: https://meet.example/sala');
  let view=await f.sales.view();assert.equal(view.appointments.length,1);assert.equal(view.appointments[0].start,'2026-11-17T17:00:00.000Z');assert.equal(view.appointments[0].name,'Ana');
  assert.doesNotMatch(await f.sales.prompt(),/2026-11-17 14:00/);
  const other='5511911112222@s.whatsapp.net';assert.match((await f.sales.plan(other,[{kind:'agendar',value:'2026-11-17 14:00'}])).problem,/não é um horário livre/);
  // Quem já tem horário pode trocar; o anterior é liberado.
  const moved=await f.sales.plan(jid,[{kind:'agendar',value:'2026-11-18 09:00'}]);await f.sales.execute(jid,moved.steps);
  view=await f.sales.view();assert.deepEqual(view.appointments.map(item=>item.label),['quarta-feira, 18/11 às 09:00']);
  const contact=(await f.store.read()).contacts[jid];assert.equal(contact.crm.followUpAt,'2026-11-18T12:00:00.000Z');assert.ok(contact.labels.includes('Reunião agendada'));
  const result=await f.sales.handle({method:'DELETE'},'/api/sales/appointments',new URL('http://x/?id='+view.appointments[0].id));assert.equal(result.body.appointments.length,0);
  await assert.rejects(f.sales.handle({method:'DELETE'},'/api/sales/appointments',new URL('http://x/?id=nada')),error=>error.status===404);
});
test('lead qualificado avança o funil uma única vez e contrato segue com arquivo e link',async t=>{
  const f=await fixture(t);await f.sales.save({qualify:{enabled:true},contract:{enabled:true,message:'Segue o contrato.',link:'https://assinatura.example/doc/1',file:{base64:'JVBERg==',mimeType:'application/pdf',fileName:'contrato.pdf'}}});
  assert.deepEqual(await f.sales.execute(jid,[]),[]);assert.equal((await f.store.read()).contacts[jid].crm.stage,'contacted');
  const planned=await f.sales.plan(jid,[{kind:'lead',value:'quer um site institucional'},{kind:'contrato',value:''},{kind:'contrato',value:''}]);
  assert.deepEqual(await f.sales.execute(jid,planned.steps),['lead qualificado','contrato enviado']);
  assert.deepEqual(f.sent,[{type:'media',to:jid,base64:'JVBERg==',mimeType:'application/pdf',fileName:'contrato.pdf',caption:'Segue o contrato.\nhttps://assinatura.example/doc/1',mediaType:'document'}]);
  const contact=(await f.store.read()).contacts[jid];assert.equal(contact.crm.stage,'negotiating');assert.match(contact.crm.notes,/quer um site institucional/);assert.deepEqual(contact.labels,['Lead qualificado','Contrato enviado']);
  assert.deepEqual(await f.sales.execute(jid,[{kind:'lead',summary:'de novo'}]),[]);
});
test('envio manual de Pix e contrato pelo atendente',async t=>{
  const f=await fixture(t),call=(route,input)=>f.sales.handle({method:'POST'},route,new URL('http://x/'),async()=>input);
  await assert.rejects(call('/api/sales/send',{jid,kind:'pix'}),error=>error.status===409);
  await f.sales.save({pix:{...pix,enabled:false}});
  assert.match((await call('/api/sales/pix/preview',{amount:'10,00'})).body.code,/540510\.00.*0505TESTE6304/);
  assert.deepEqual((await call('/api/sales/send',{jid,kind:'pix',amount:'75,50'})).body,{sent:true,kind:'pix',amount:75.5});assert.equal(f.sent.length,2);
  await call('/api/sales/send',{jid,kind:'pix'});assert.match(f.sent.at(-1).text,/53039865802BR/);assert.match(f.sent.at(-2).text,/^Pix para João/);
  await assert.rejects(call('/api/sales/send',{jid,kind:'contract'}),error=>error.status===409);
  await assert.rejects(call('/api/sales/send',{jid:'grupo@g.us',kind:'pix'}),error=>error.status===422);
});

test('lembrete sai uma única vez antes do horário e respeita cancelamento, pausa e marcação em cima da hora',async t=>{
  const f=await fixture(t),other='5511911112222@s.whatsapp.net',late='5511933334444@s.whatsapp.net',paused='5511955556666@s.whatsapp.net',book=async(to,value)=>f.sales.execute(to,(await f.sales.plan(to,[{kind:'agendar',value}])).steps);
  await assert.rejects(f.sales.save({agenda:{reminders:[7]}}),error=>error.status===422);
  const saved=await f.sales.save({agenda:{enabled:true,subject:'uma reunião de apresentação',slotMinutes:60,note:'Link: https://meet.example/sala',reminders:[60,1440]}});
  assert.deepEqual(saved.agenda.reminders,[1440,60]);
  // Terça 17/11: 14:00 (lembretes de 1 dia e de 1 hora), 15:00 (será cancelado) e 16:00 (contato com automações pausadas).
  await book(jid,'2026-11-17 14:00');await book(other,'2026-11-17 15:00');await book(paused,'2026-11-17 16:00');
  await f.store.update(data=>{data.contacts[paused].automationPaused=true;});
  const cancelled=(await f.sales.view()).appointments.find(item=>item.jid===other);
  await f.sales.handle({method:'DELETE'},'/api/sales/appointments',new URL('http://x/?id='+cancelled.id));
  f.sent.length=0;await f.sales.tick();assert.equal(f.sent.length,0);
  // Segunda 14:00: falta 1 dia para a reunião das 14:00.
  f.advance(4*3600_000);await f.sales.tick();await f.sales.tick();
  assert.deepEqual(f.sent,[{type:'text',to:jid,text:'Olá! Passando para lembrar do nosso compromisso: uma reunião de apresentação, terça-feira, 17/11 às 14:00.\nLink: https://meet.example/sala'}]);
  // Terça 13:10: sai o lembrete de 1 hora das 14:00. Quem marca agora para as 17:00 não recebe o aviso de 1 dia, cujo momento já passou.
  f.advance(23*3600_000+10*60_000);f.sent.length=0;
  await book(late,'2026-11-17 17:00');assert.equal((await f.sales.view()).appointments.some(item=>item.jid===late),true);f.sent.length=0;
  await f.sales.tick();
  assert.deepEqual(f.sent.map(item=>item.to),[jid]);
  // Terça 16:05: o das 17:00 recebe o aviso de 1 hora; o contato pausado (16:00) nunca recebeu.
  f.advance(175*60_000);f.sent.length=0;await f.sales.tick();
  assert.deepEqual(f.sent.map(item=>item.to),[late]);
  f.advance(2*3600_000);f.sent.length=0;await f.sales.tick();assert.equal(f.sent.length,0);
  assert.equal((await f.sales.view()).log.filter(entry=>entry.action==='reminder').length,3);
});
test('central parada: ao voltar sai um só lembrete, e nenhum depois do horário',async t=>{
  const f=await fixture(t);await f.sales.save({agenda:{enabled:true,slotMinutes:60,reminders:[1440,60]}});
  await f.sales.execute(jid,(await f.sales.plan(jid,[{kind:'agendar',value:'2026-11-18 10:00'}])).steps);f.sent.length=0;
  f.advance(46*3600_000+30*60_000);await f.sales.tick();await f.sales.tick();
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/quarta-feira, 18\/11 às 10:00/);
  const g=await fixture(t);await g.sales.save({agenda:{enabled:true,slotMinutes:60}});
  await g.sales.execute(jid,(await g.sales.plan(jid,[{kind:'agendar',value:'2026-11-18 10:00'}])).steps);g.sent.length=0;
  g.advance(48*3600_000);await g.sales.tick();assert.equal(g.sent.length,0);
  const off=await fixture(t);await off.sales.save({agenda:{enabled:true,slotMinutes:60,reminders:[]}});
  await off.sales.execute(jid,(await off.sales.plan(jid,[{kind:'agendar',value:'2026-11-18 10:00'}])).steps);off.sent.length=0;
  off.advance(46*3600_000+30*60_000);await off.sales.tick();assert.equal(off.sent.length,0);
});

// ---------- IA + vendas ----------
async function assistantFixture(t,reply,{mode='auto'}={}) {
  const f=await fixture(t),last={id:'m1',jid,timestamp:START+1000,type:'text',text:'Quero fechar o logo',fromMe:false,key:{id:'m1',remoteJid:jid,fromMe:false}};
  let arrived=false;const systems=[];
  Object.assign(f.client,{chats:async()=>arrived?[{jid,name:'Ana',lastMessage:last}]:[],messages:async()=>({messages:[last],pages:1})});
  const assistant=createAssistantService({store:f.store,client:f.client,sales:f.sales,ai:{config:async()=>({configured:true}),complete:async({system})=>{systems.push(system);return reply;}},loadTexts:async()=>[],retrieve:async()=>[],catalogText:async()=>'- [Design] Logo (R$ 180,00)',now:()=>f.time.value});
  t.after(()=>assistant.stop());
  await f.store.update(data=>{data.contacts ||= {};data.contacts[jid]={status:'open',labels:[],notes:[],aiMode:mode,aiSince:new Date(START-1000).toISOString()};data.assistant={enabled:true};});
  assistant.start({poll:false});f.advance(2000);arrived=true;
  return {...f,assistant,systems};
}
test('IA fecha a venda: texto sem a marcação, depois o Pix conferido pelo catálogo',async t=>{
  const f=await assistantFixture(t,'Combinado! Estou enviando o código Pix de R$ 180,00.\n[[PIX: 180,00]]');await f.sales.save({pix});
  await f.assistant.tick();
  assert.match(f.systems[0],/Ferramentas de venda/);
  assert.deepEqual(f.sent.map(item=>item.text.slice(0,24)),['Combinado! Estou enviand','Pix de R$ 180,00 para Jo','00020126400014br.gov.bcb']);
  assert.match((await f.store.read()).assistant.log[0].detail,/Pix de R\$ 180,00 enviado/);
});
test('ação que não pode ser cumprida não envia nada e chama um atendente',async t=>{
  const f=await assistantFixture(t,'Estou enviando o Pix.\n[[PIX: 50,00]]');await f.sales.save({pix});
  await f.assistant.tick();
  assert.equal(f.sent.length,0);const data=await f.store.read();assert.ok(data.contacts[jid].labels.includes('Atendente'));assert.match(data.assistant.log[0].detail,/não é o preço de nenhum item/);
});
test('em rascunho a IA não executa ações e, com vendas desligadas, marcações são ignoradas',async t=>{
  const f=await assistantFixture(t,'Posso enviar o Pix.\n[[PIX: 180,00]]',{mode:'draft'});await f.sales.save({pix});
  await f.assistant.tick();
  assert.equal(f.sent.length,0);const data=await f.store.read();assert.equal(data.contacts[jid].aiDraft.text,'Posso enviar o Pix.');assert.match(data.assistant.log[0].detail,/A IA sugeriu: enviar Pix de 180,00/);
  const off=await assistantFixture(t,'Olá! Como posso ajudar?\n[[CONTRATO]]');await off.assistant.tick();
  assert.deepEqual(off.sent.map(item=>item.text),['Olá! Como posso ajudar?']);assert.doesNotMatch(off.systems[0],/Ferramentas de venda/);
});
