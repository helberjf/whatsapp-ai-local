const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createAssistantService}=require('../lib/assistant.cjs');

const jid='5511998765432@s.whatsapp.net',otherJid='5511888888888@s.whatsapp.net';
const message=(id,text,fromMe,timestamp)=>({id,jid,text,fromMe,timestamp,type:'text',key:{id,remoteJid:jid,fromMe}});

async function fixture(t,records,{documents=[]}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-assistant-context-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(dir),calls=[],sent=[],reads=[];
  const client={messages:async(target,page)=>{reads.push({target,page});return {messages:records,pages:1};},chats:async()=>[{jid,lastMessage:records.at(-1)}],sendText:async(...args)=>{sent.push(args);}};
  const ai={config:async()=>({configured:true}),complete:async options=>{calls.push(options);return 'Podemos continuar a cotação. Qual data você prefere?';}};
  const service=createAssistantService({store,client,ai,loadTexts:async()=>documents,catalogText:async()=>'SERVIÇOS\n- Passagens aéreas (valor sob consulta)'});
  t.after(()=>service.stop());
  return {store,calls,sent,reads,service,draft:()=>service.handle({method:'POST'},'/api/assistant/draft',null,async()=>({jid}))};
}
const history=call=>call.messages.filter(turn=>!turn.content.startsWith('Pedido do atendente:'));

test('sugestão manual considera mensagens recebidas e enviadas mesmo após a resposta do atendente',async t=>{
  const records=[message('1','Olá! Preciso de uma passagem para Lisboa.',false,1),message('2','Qual será a origem?',true,2),message('3','São Paulo, em dezembro.',false,3),message('4','Certo. Vou verificar as opções.',true,4)];
  const f=await fixture(t,records),before=await f.store.read(),response=await f.draft();
  assert.equal(response.status,200);assert.equal(response.body.contextLastId,'4');
  assert.equal(response.body.handoff,false);assert.match(response.body.text,/continuar/);assert.ok(Array.isArray(response.body.sources));
  assert.deepEqual(history(f.calls[0]),records.map(row=>({role:row.fromMe?'assistant':'user',content:row.text})));
  assert.equal(f.calls[0].messages.at(-1).role,'user','O pedido de próxima sugestão encerra o histórico para todos os provedores.');
  assert.match(f.calls[0].system,/histórico[\s\S]*prioridade/i);assert.match(f.calls[0].system,/não (?:repita|invente)/i);
  assert.doesNotMatch(f.calls[0].system,/Se a informação não existir ou o cliente pedir uma pessoa/,'Continuar o diálogo não exige que as preferências do cliente estejam na base comercial.');
  assert.deepEqual(f.reads,[{target:jid,page:1}]);assert.deepEqual(await f.store.read(),before);assert.equal(f.sent.length,0);
});

test('sugestão manual preserva uma conversa que começa com mensagem enviada',async t=>{
  const records=[message('1','Olá! Seu orçamento está em análise.',true,1)];
  const f=await fixture(t,records),response=await f.draft();
  assert.equal(response.body.contextLastId,'1');
  assert.deepEqual(history(f.calls[0]),[{role:'assistant',content:records[0].text}]);
  assert.equal(f.calls[0].messages[0].role,'user');assert.equal(f.calls[0].messages.at(-1).role,'user');
});

test('sugestão manual ordena a conversa e usa somente as 14 mensagens mais recentes',async t=>{
  const records=Array.from({length:22},(_,index)=>message(String(index),'Mensagem '+index,index%2===1,index+1));
  const f=await fixture(t,[...records].reverse());
  const response=await f.draft();
  assert.equal(response.body.contextLastId,'21');
  assert.deepEqual(history(f.calls[0]),records.slice(-14).map(row=>({role:row.fromMe?'assistant':'user',content:row.text})));
});

test('sugestão manual limita o texto do histórico a 12 mil caracteres mantendo as informações mais recentes',async t=>{
  const records=[message('old','ASSUNTO ANTIGO '+'.'.repeat(9000),false,1),message('large','INÍCIO REMOVIDO '+'.'.repeat(14000)+' DETALHE RECENTE',false,2),message('sent','Vou conferir o detalhe recente.',true,3)];
  const f=await fixture(t,records);await f.draft();
  const turns=history(f.calls[0]),text=turns.map(turn=>turn.content).join('\n');
  assert.ok(text.length<=12000);assert.match(text,/DETALHE RECENTE\nVou conferir o detalhe recente\.$/);
  assert.doesNotMatch(text,/ASSUNTO ANTIGO|INÍCIO REMOVIDO/);
});

test('sugestão manual exclui outra conversa, mensagens apagadas e conteúdo coberto por tombstone',async t=>{
  const records=[message('1','Preciso remarcar minha passagem.',false,1),message('gone','DADO APAGADO',false,2),{...message('gone','Mensagem apagada',false,3),type:'deleted',deleted:true},
    {...message('wrong','SEGREDO OUTRA CONVERSA',false,4),jid:otherJid,key:{id:'wrong',remoteJid:otherJid,fromMe:false}},
    {...message('wrong-key','OUTRO REMOTE JID',false,5),key:{id:'wrong-key',remoteJid:otherJid,fromMe:false}},
    {...message('deleted-flag','EXCLUÍDO PELO STATUS',false,6),status:'DELETED'},
    {...message('deleted-key','EXCLUÍDO PELA CHAVE',false,7),key:{id:'deleted-key',remoteJid:jid,fromMe:false,deleted:true}},
    {...message('protocol','[protocolMessage]',false,8),canForward:false},
    message('last','O voo é para Lisboa.',false,9)];
  const f=await fixture(t,records),response=await f.draft();
  assert.equal(response.body.contextLastId,'last');
  assert.deepEqual(history(f.calls[0]),[{role:'user',content:'Preciso remarcar minha passagem.\nO voo é para Lisboa.'}]);
});

test('a busca complementar usa a troca recente para entender respostas curtas do cliente',async t=>{
  const records=[message('old-user','hotel hospedagem reserva de hotel',false,1),message('old-agent','Falamos sobre hotel e hospedagem.',true,2),message('old-user-2','A reserva do hotel foi resolvida.',false,3),message('old-agent-2','Tudo certo com a hospedagem.',true,4),
    message('flight','Agora preciso de passagens aéreas para Lisboa.',false,5),message('asked','Você quer uma passagem aérea somente de ida?',true,6),message('yes','Sim.',false,7),message('ack','Certo, vou conferir.',true,8)];
  const f=await fixture(t,records,{documents:[{id:'hotel',name:'hoteis.md',text:'Hotel hospedagem reserva de hotel.'},{id:'flight',name:'passagens.md',text:'Passagens aéreas para Lisboa e passagem aérea somente de ida são cotadas com o atendente.'}]});
  const response=await f.draft();
  assert.deepEqual(response.body.sources.map(source=>source.doc),['passagens.md']);
  assert.match(f.calls[0].system,/<contexto>[\s\S]*cotadas com o atendente/);assert.match(f.calls[0].system,/<catalogo>[\s\S]*Passagens aéreas/);
});

test('sugestão manual rejeita histórico sem texto útil antes de chamar a IA',async t=>{
  const f=await fixture(t,[{...message('gone','Mensagem apagada',false,1),deleted:true}, {...message('audio','',false,2),type:'audio'}]);
  await assert.rejects(f.draft(),error=>error.status===409 && /texto.*conversa/i.test(error.message));
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});

test('sugestão manual não torna mensagem enviada elegível para resposta automática',async t=>{
  const timestamp=Date.now()+1000,records=[message('received','Preciso de uma passagem.',false,timestamp),message('sent','Qual é o destino?',true,timestamp+1)];
  const f=await fixture(t,records);
  await f.store.update(data=>{data.assistant={enabled:true,enabledSince:new Date(timestamp-10000).toISOString()};data.contacts[jid]={aiMode:'auto',aiSince:new Date(timestamp-10000).toISOString()};});
  await f.draft();await f.service.tick();
  assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);assert.equal((await f.store.read()).contacts[jid].aiHandled,undefined);
});
