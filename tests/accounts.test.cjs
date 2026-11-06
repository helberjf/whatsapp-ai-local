const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../server.cjs');

const jid='5511998765432@s.whatsapp.net',other='5521988887777@s.whatsapp.net';
const token=64;
// Conector de mentira com várias instâncias. A conta real nunca é tocada por estes testes.
function connector(start={}) {
  const instances=new Map(Object.entries(start)),calls=[];
  const fetchImpl=async(url,options={})=>{
    const target=new URL(url),route=target.pathname,input=options.body?JSON.parse(options.body):null;
    const name=route==='/instance/create'?input.instanceName:route==='/instance/fetchInstances'?target.searchParams.get('instanceName'):decodeURIComponent(route.split('/').pop());
    calls.push({route,method:options.method,instance:name,input});
    const item=instances.get(name),send=body=>new Response(JSON.stringify(body));
    if(route==='/instance/create') {if(item) return new Response('{}',{status:409});instances.set(name,{state:'close',chats:[],sent:[]});return send({instance:{instanceName:name}});}
    if(!item) return new Response('{}',{status:404});
    if(item.broken) return new Response('{}',{status:500});
    if(route.startsWith('/instance/connectionState/')) return send({instance:{state:item.state}});
    if(route==='/instance/fetchInstances') return send([{name,ownerJid:item.owner}]);
    if(route.startsWith('/instance/connect/')) return send({base64:'data:image/png;base64,cXI=',count:1});
    if(route.startsWith('/instance/logout/')) {item.state='close';return send({status:'SUCCESS'});}
    if(route.startsWith('/instance/delete/')) {instances.delete(name);return send({status:'SUCCESS'});}
    if(route.startsWith('/chat/findChats/')) return send(item.chats);
    if(route.startsWith('/chat/findContacts/')) return send([]);
    if(route.startsWith('/chat/findMessages/')) return send({messages:{total:item.chats.length,pages:1,currentPage:1,records:item.chats.filter(chat=>chat.remoteJid===input.where.key.remoteJid).map(chat=>chat.lastMessage).filter(Boolean)}});
    if(route.startsWith('/message/sendText/')) {item.sent.push(input);return send({key:{id:'out-'+item.sent.length,remoteJid:input.number,fromMe:true},message:{conversation:input.text},status:'PENDING'});}
    return send({});
  };
  return {instances,calls,fetchImpl};
}
const instance=(chats=[],owner=jid)=>({state:'open',owner,chats,sent:[]});
const incoming=(remoteJid,text,at)=>({remoteJid,pushName:'Ana',unreadCount:1,lastMessage:{key:{id:'in-'+text,remoteJid,fromMe:false},message:{conversation:text},messageTimestamp:Math.floor(at/1000),status:'DELIVERY_ACK'}});
async function harness(t,upstream,extra={}) {
  const directory=extra.directory || await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-accounts-test-'));
  const open=async()=>{
    const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:9',apiKey:'k',instanceName:'whatsapp-local',...extra.config},storeDir:directory,fetchImpl:upstream.fetchImpl,disableWorkers:true,...extra.options});
    // Sem conexões reaproveitadas: o sistema pode repetir a porta de um servidor já fechado por outro teste.
    server.prependListener('request',(request,response)=>response.setHeader('Connection','close'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,html=await(await fetch(base)).text(),session=html.match(new RegExp(`whatsapp-session" content="([a-f0-9]{${token}})"`))[1];
    const call=async(route,method='GET',input,account)=>{
      const response=await fetch(base+route,{method,headers:{'X-WhatsApp-Token':session,...(account?{'X-WhatsApp-Account':account}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
      return {status:response.status,body:await response.json(),account:response.headers.get('x-whatsapp-account')};
    };
    const close=async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;};
    return {server,base,html,call,close};
  };
  const app=await open();let current=app;
  t.after(async()=>{await current.close();if(!extra.directory) await fs.rm(directory,{recursive:true,force:true});});
  return {...app,directory,reopen:async()=>{await current.close();current=await open();return current;}};
}
const body=async result=>{const value=await result;assert.ok(value.status<300,JSON.stringify(value));return value.body;};

test('a conta já pareada continua igual: mesma instância, mesmo arquivo e nenhum novo QR Code',async t=>{
  const upstream=connector({'whatsapp-local':instance([incoming(jid,'Oi',1793200000000)])});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-accounts-test-'));
  const saved={contacts:{[jid]:{status:'pending',labels:['VIP'],notes:[{id:'n',text:'Histórico antigo',at:'2026-01-01T00:00:00.000Z'}]}},requests:{},settings:{templates:[{name:'Minha',body:'Resposta'}]}};
  await fs.writeFile(path.join(directory,'atendimento.json'),JSON.stringify(saved));
  const app=await harness(t,upstream,{directory});t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const [account]=await body(app.call('/api/accounts'));
  assert.deepEqual([account.id,account.instanceName,account.state,account.phone],['principal','whatsapp-local','connected','5511998765432']);
  const chats=await body(app.call('/api/chats'));assert.deepEqual(chats[0].labels,['VIP']);assert.equal(chats[0].status,'pending');
  assert.equal((await app.call('/api/connection')).account,'principal');
  assert.equal((await body(app.call('/api/connect','POST',{}))).base64,null);
  assert.equal(upstream.calls.some(call=>['/instance/create'].includes(call.route) || /logout|delete/.test(call.route)),false);
  await assert.rejects(fs.access(path.join(directory,'contas.json')),'nada é gravado enquanto existir uma só conta');
  await body(app.call('/api/accounts','POST',{name:'Loja'}));
  const registry=JSON.parse(await fs.readFile(path.join(directory,'contas.json'),'utf8'));
  assert.equal(registry.accounts[0].instanceName,'whatsapp-local');assert.equal(registry.accounts.length,2);
  // O atendimento da conta principal continua em data/central.sqlite, igual a antes de existirem outras contas.
  assert.equal((await body(app.call('/api/contact?jid='+encodeURIComponent(jid)))).notes[0].text,'Histórico antigo');
  await fs.access(path.join(directory,'central.sqlite'));
  await assert.rejects(fs.access(path.join(directory,'contas',registry.accounts[1].id,'atendimento.json')));
});

test('adicionar conta cria só a nova instância e informa o estado de cada uma',async t=>{
  const upstream=connector({'whatsapp-local':instance()}),app=await harness(t,upstream);
  assert.equal((await app.call('/api/accounts','POST',{name:'  '})).status,422);
  assert.equal((await app.call('/api/accounts','POST',{name:'conta PRINCIPAL'})).status,409);
  const added=await body(app.call('/api/accounts','POST',{name:'Loja'}));
  assert.equal(upstream.instances.has(added.instanceName),false,'a instância nasce só ao pedir o QR Code');
  const before=await body(app.call('/api/accounts'));
  assert.deepEqual(before.map(item=>[item.name,item.state,item.exists]),[['Conta principal','connected',true],['Loja','disconnected',false]]);
  const qr=await body(app.call('/api/connect','POST',{},added.id));assert.match(qr.base64,/^data:image\/png/);
  assert.deepEqual(upstream.calls.filter(call=>call.route==='/instance/create').map(call=>call.instance),[added.instanceName]);
  upstream.instances.get(added.instanceName).state='open';upstream.instances.get(added.instanceName).owner=other;
  const after=await body(app.call('/api/accounts'));assert.deepEqual(after.map(item=>[item.state,item.phone]),[['connected','5511998765432'],['connected','5521988887777']]);
  assert.equal(after.some(item=>item.duplicatePhone),false);
  upstream.instances.get(added.instanceName).owner=jid;
  assert.deepEqual((await body(app.call('/api/accounts'))).map(item=>item.duplicatePhone),[true,true]);
  assert.match(app.html,/name="whatsapp-accounts" content="principal"/);
  assert.match(await(await fetch(app.base)).text(),new RegExp(`name="whatsapp-accounts" content="principal,${added.id}"`));
});

test('conversas, contatos e envios ficam na conta escolhida, sem cair na conta padrão',async t=>{
  const upstream=connector({'whatsapp-local':instance([incoming(jid,'Para a principal',Date.now())])}),app=await harness(t,upstream);
  const added=await body(app.call('/api/accounts','POST',{name:'Loja'}));
  upstream.instances.set(added.instanceName,instance([incoming(other,'Para a loja',Date.now())],other));
  assert.deepEqual((await body(app.call('/api/chats'))).map(chat=>chat.jid),[jid]);
  assert.deepEqual((await body(app.call('/api/chats','GET',undefined,added.id))).map(chat=>chat.jid),[other]);
  await body(app.call('/api/contact?jid='+encodeURIComponent(jid),'PATCH',{labels:['Só da loja']},added.id));
  assert.deepEqual((await body(app.call('/api/contact?jid='+encodeURIComponent(jid)))).labels,[]);
  assert.deepEqual((await body(app.call('/api/contact?jid='+encodeURIComponent(jid),'GET',undefined,added.id))).labels,['Só da loja']);
  // O mesmo identificador de envio não colide entre contas.
  const send={jid:other,text:'Olá',requestId:'pedido-12345678'};
  const sent=await app.call('/api/send','POST',send,added.id);assert.equal(sent.status,200);assert.equal(sent.account,added.id);
  assert.equal(upstream.instances.get(added.instanceName).sent.length,1);assert.equal(upstream.instances.get('whatsapp-local').sent.length,0);
  await body(app.call('/api/send','POST',send));assert.equal(upstream.instances.get('whatsapp-local').sent.length,1);
  const before=upstream.calls.length,lost=await app.call('/api/send','POST',{...send,requestId:'pedido-87654321'},'conta-inexistente');
  assert.equal(lost.status,404);assert.equal(upstream.calls.length,before,'conta desconhecida nunca envia pela padrão');
});

test('agendamentos e robôs saem pela conta dona da regra',async t=>{
  let clock=Date.parse('2026-11-02T14:00:00.000Z');
  const upstream=connector({'whatsapp-local':instance()}),app=await harness(t,upstream,{options:{now:()=>clock}});
  const added=await body(app.call('/api/accounts','POST',{name:'Loja'}));
  upstream.instances.set(added.instanceName,instance([],other));
  const job=await body(app.call('/api/scheduled-messages','POST',{jid:other,text:'Lembrete',scheduledAt:new Date(clock+60000).toISOString(),requestId:'agenda-12345678'},added.id));
  assert.deepEqual(await body(app.call('/api/scheduled-messages')),[]);
  assert.deepEqual((await body(app.call('/api/scheduled-messages','GET',undefined,added.id))).map(item=>item.id),[job.id]);
  clock+=61000;await app.server.accounts.get(added.id).scheduler.tick();await app.server.accounts.get('principal').scheduler.tick();
  assert.deepEqual(upstream.instances.get(added.instanceName).sent.map(item=>item.text),['Lembrete']);assert.equal(upstream.instances.get('whatsapp-local').sent.length,0);
  await body(app.call('/api/automation/settings','PATCH',{enabled:true,rules:[{name:'Preço',keywords:['preço'],match:'contains',response:'Resposta da loja'}]},added.id));
  assert.equal((await body(app.call('/api/automation/settings'))).enabled,false,'a regra não vaza para a outra conta');
  // O robô usa o relógio real e só responde a mensagens posteriores à ativação (em segundos, como no WhatsApp).
  await new Promise(resolve=>setTimeout(resolve,1100));
  const at=Date.now();upstream.instances.get(added.instanceName).chats=[incoming(other,'Qual o preço?',at)];upstream.instances.get('whatsapp-local').chats=[incoming(jid,'Qual o preço?',at)];
  for(const runtime of app.server.accounts.values()) await runtime.automation.tick();
  assert.deepEqual(upstream.instances.get(added.instanceName).sent.map(item=>[item.number,item.text]).at(-1),[other,'Resposta da loja']);
  assert.equal(upstream.instances.get('whatsapp-local').sent.length,0);
  const events=await body(app.call('/api/automation/executions','GET',undefined,added.id));assert.equal(events[0].jid,other);assert.deepEqual(await body(app.call('/api/automation/executions')),[]);
});

test('desconectar ou remover uma conta não afeta as outras, e a lista sobrevive ao reinício',async t=>{
  const upstream=connector({'whatsapp-local':instance()}),app=await harness(t,upstream);
  const added=await body(app.call('/api/accounts','POST',{name:'Loja'}));
  upstream.instances.set(added.instanceName,instance([],other));
  await body(app.call('/api/contact?jid='+encodeURIComponent(other),'PATCH',{labels:['Guardar']},added.id));
  assert.equal((await app.call(`/api/accounts/${added.id}`,'PATCH',{name:'Conta principal'})).status,409);
  assert.equal((await body(app.call(`/api/accounts/${added.id}`,'PATCH',{name:'Loja Centro'}))).name,'Loja Centro');
  await body(app.call(`/api/accounts/${added.id}/disconnect`,'POST',{}));
  assert.deepEqual(upstream.calls.filter(call=>/logout/.test(call.route)).map(call=>call.instance),[added.instanceName]);
  assert.equal(upstream.instances.get('whatsapp-local').state,'open');
  const reopened=await app.reopen();
  assert.deepEqual((await body(reopened.call('/api/accounts'))).map(item=>[item.name,item.state]),[['Conta principal','connected'],['Loja Centro','disconnected']]);
  assert.equal((await reopened.call('/api/accounts/naoexiste','DELETE')).status,404);
  upstream.instances.get(added.instanceName).broken=true;
  assert.equal((await reopened.call(`/api/accounts/${added.id}`,'DELETE')).status,502,'falha no conector não remove a conta');
  assert.equal((await body(reopened.call('/api/accounts'))).length,2);
  delete upstream.instances.get(added.instanceName).broken;
  await body(reopened.call(`/api/accounts/${added.id}`,'DELETE'));
  assert.deepEqual(upstream.calls.filter(call=>/delete/.test(call.route)).map(call=>call.instance),[added.instanceName,added.instanceName]);
  assert.equal(upstream.instances.has('whatsapp-local'),true);
  assert.deepEqual((await body(reopened.call('/api/accounts'))).map(item=>item.id),['principal']);
  assert.equal((await reopened.call('/api/chats','GET',undefined,added.id)).status,404);
  const [archived]=await fs.readdir(path.join(app.directory,'contas-arquivadas'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.directory,'contas-arquivadas',archived),'utf8')).contacts[other].labels,['Guardar']);
  assert.equal((await reopened.call('/api/accounts/principal','DELETE')).status,409,'a última conta não pode ser removida');
  assert.equal(upstream.instances.has('whatsapp-local'),true);
});

test('a conta principal pode sair sem levar as outras, e a próxima vira a padrão',async t=>{
  const upstream=connector({'whatsapp-local':instance()}),app=await harness(t,upstream);
  const added=await body(app.call('/api/accounts','POST',{name:'Loja'}));upstream.instances.set(added.instanceName,instance([],other));
  await body(app.call('/api/accounts/principal','DELETE'));
  assert.equal((await app.call('/api/connection')).account,added.id);
  const reopened=await app.reopen();assert.equal((await body(reopened.call('/api/connection'))).phone,'5521988887777');
  await body(reopened.call('/api/send','POST',{jid:other,text:'Oi',requestId:'pedido-principal'}));
  assert.equal(upstream.instances.get(added.instanceName).sent.length,1);
});

test('remoções simultâneas sempre deixam uma conta',async t=>{
  const upstream=connector({'whatsapp-local':instance()}),app=await harness(t,upstream);
  const added=await body(app.call('/api/accounts','POST',{name:'Loja'}));upstream.instances.set(added.instanceName,instance([],other));
  const results=await Promise.all([app.call('/api/accounts/principal','DELETE'),app.call('/api/accounts/'+added.id,'DELETE')]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  assert.equal((await body(app.call('/api/accounts'))).length,1);assert.equal(upstream.instances.size,1);
});

test('integração local usa a conta padrão e pode escolher outra; não administra contas',async t=>{
  const integrationToken='i'.repeat(40),upstream=connector({'whatsapp-local':instance()}),app=await harness(t,upstream,{config:{integrationToken}});
  const added=await body(app.call('/api/accounts','POST',{name:'Loja'}));upstream.instances.set(added.instanceName,instance([],other));
  const call=(route,method='GET',account,input)=>fetch(app.base+route,{method,headers:{'X-Integration-Token':integrationToken,...(account?{'X-WhatsApp-Account':account}:{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
  assert.equal((await (await call('/api/connection')).json()).accountId,'principal');
  assert.equal((await (await call('/api/connection','GET',added.id)).json()).phone,'5521988887777');
  assert.equal((await call('/api/accounts')).status,403);
  assert.equal((await call('/api/accounts/principal','DELETE')).status,403);
  assert.equal((await call('/api/send','POST',added.id,{jid:other,text:'Oi',requestId:'radar-12345678'})).status,200);
  assert.equal(upstream.instances.get(added.instanceName).sent.length,1);assert.equal(upstream.instances.get('whatsapp-local').sent.length,0);
});

test('registro corrompido impede a partida em vez de esquecer contas',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-accounts-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'contas.json'),'{quebrado');
  assert.throws(()=>createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:9',apiKey:'k',instanceName:'x'},storeDir:directory,fetchImpl:async()=>new Response('{}')}),/contas\.json/);
});
