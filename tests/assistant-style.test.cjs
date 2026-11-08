const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createAssistantService}=require('../lib/assistant.cjs');
const core=require('../lib/assistant-core.cjs');

const jid='5511998765432@s.whatsapp.net';
const message=(id,text,fromMe,timestamp)=>({id,jid,text,fromMe,timestamp,type:'text',key:{id,remoteJid:jid,fromMe}});
const records=Array.from({length:10},(_,index)=>message(String(index+1),`Mensagem ${index+1}`,index%2===1,index+1));

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-assistant-style-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(dir),calls=[],searches=[];let catalogReads=0;
  const client={messages:async()=>({messages:records,pages:1}),chats:async()=>[{jid,lastMessage:records.at(-1)}],sendText:async()=>{}};
  const ai={config:async()=>({configured:true}),complete:async options=>{calls.push(options);return 'Beleza, já vejo isso pra você.';}};
  const service=createAssistantService({store,client,ai,retrieve:async query=>{searches.push(query);return [{docName:'precos.md',text:'Produto A custa R$ 10.',relevance:1,confidence:'alta'}];},catalogText:async()=>{catalogReads++;return 'PRODUTOS\n- Produto A (R$ 10,00)';}});
  t.after(()=>service.stop());
  const call=(method,route,input)=>service.handle({method},route,null,async()=>input);
  return {calls,searches,catalogReads:()=>catalogReads,call,draft:()=>call('POST','/api/assistant/draft',{jid})};
}

test('padrão: consulta a base e o catálogo, lê 14 mensagens e usa tom profissional',async t=>{
  const f=await fixture(t),view=(await f.call('GET','/api/assistant')).body;
  assert.deepEqual([view.source,view.history,view.tone],['base',14,'formal']);
  await f.draft();
  assert.equal(f.searches.length,1);assert.equal(f.catalogReads(),1);
  assert.match(f.calls[0].system,/<contexto>[\s\S]*Produto A custa/);
  assert.doesNotMatch(f.calls[0].system,/pessoa de verdade/);
});

test('só a conversa: nenhuma busca na base nem catálogo, e a IA lê só as últimas mensagens escolhidas',async t=>{
  const f=await fixture(t);
  const saved=(await f.call('PUT','/api/assistant',{source:'conversation',history:4})).body;
  assert.deepEqual([saved.source,saved.history],['conversation',4]);
  const response=await f.draft();
  assert.equal(response.status,200);assert.deepEqual(response.body.sources,[]);
  assert.deepEqual([f.searches.length,f.catalogReads()],[0,0]);
  const system=f.calls[0].system;
  assert.match(system,/apenas com base nas mensagens desta conversa/);assert.match(system,/Nunca invente preços/);
  assert.doesNotMatch(system,/<catalogo>|<contexto>|Produto A/);
  const history=f.calls[0].messages.filter(turn=>!turn.content.startsWith('Pedido do atendente:')).map(turn=>turn.content).join('\n');
  assert.equal(history,'Mensagem 7\nMensagem 8\nMensagem 9\nMensagem 10','Lê só as 4 últimas.');
});

test('tom natural entra no prompt nos dois modos, sem tirar os limites de conteúdo',async t=>{
  const f=await fixture(t);
  await f.call('PUT','/api/assistant',{tone:'natural'});await f.draft();
  assert.match(f.calls[0].system,/pessoa de verdade[\s\S]*Prezado/);assert.match(f.calls[0].system,/<catalogo>/);
  await f.call('PUT','/api/assistant',{source:'conversation'});await f.draft();
  assert.match(f.calls[1].system,/pessoa de verdade/);assert.match(f.calls[1].system,/Nunca invente/);
  const rules=[{title:'Tom',text:'Seja breve.',enabled:true}];
  for(const suggestion of [false,true]) assert.match(core.buildSystem({rules,source:'conversation',tone:'natural',suggestion}),/Seja breve[\s\S]*$/,'As regras da empresa continuam valendo.');
});

test('valores inválidos são recusados e não mudam a configuração',async t=>{
  const f=await fixture(t);
  for(const input of [{source:'internet'},{tone:'gírias'},{history:1},{history:31},{history:'10'}]) assert.equal((await f.call('PUT','/api/assistant',input).catch(error=>({status:error.status}))).status,422,JSON.stringify(input));
  const view=(await f.call('GET','/api/assistant')).body;
  assert.deepEqual([view.source,view.history,view.tone],['base',14,'formal']);
});
