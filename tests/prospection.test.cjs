const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../server.cjs');
const secret='integration-secret-'.repeat(3);
const support='c0ca037d51f6';
const queue={accountId:support,accountName:'suporte',systemUrl:'http://localhost:3000/rascunhos',items:[{messageId:'draft-1',conversationId:'chat-1',businessId:'biz-1',name:'Loja',phone:'5511999998888',body:'Olá, Loja!'}]};
async function harness(t,options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-prospection-')),calls=[],connector=[];
  const server=createWhatsAppServer({storeDir:directory,disableWorkers:true,
    config:{apiUrl:'http://127.0.0.1:9',apiKey:'fixture',instanceName:'principal',integrationToken:secret,...options.config},
    initialAccounts:[{id:'principal',name:'Conta principal',instanceName:'principal'},{id:support,name:'suporte',instanceName:'suporte'}],
    fetchImpl:async(url)=>{connector.push(String(url));return new Response('{}');},
    prospectionFetch:async(url,init)=>{calls.push({url,init});return options.upstream?options.upstream(url,init):Response.json(queue);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
  const base=`http://127.0.0.1:${server.address().port}`,html=await(await fetch(base)).text(),token=html.match(/name="whatsapp-session" content="([a-f0-9]+)"/)[1];
  const call=(method='GET',input,account=support,headers={})=>fetch(base+'/api/prospection/drafts',{method,headers:{'X-WhatsApp-Token':token,...(account?{'X-WhatsApp-Account':account}:{}),...headers,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
  return {call,calls,connector,base};
}
test('support session can list, prepare and save drafts without calling WhatsApp',async t=>{
  const app=await harness(t);
  for(const [method,input] of [['GET'],['POST',{}],['PATCH',{messageId:'draft-1',body:'Texto revisado',expectedBody:'Olá, Loja!',send:true}]]) {
    const response=await app.call(method,input);assert.equal(response.status,200);assert.deepEqual(await response.json(),queue);
  }
  assert.equal(app.calls.length,3);assert.deepEqual(app.connector,[]);
  for(const {url,init} of app.calls) {
    assert.equal(url,'http://127.0.0.1:3000/api/outreach/review-batch');assert.equal(init.headers['X-Integration-Token'],secret);
    assert.equal(init.headers['X-WhatsApp-Account'],support);assert.equal(init.redirect,'error');assert.ok(init.signal);
  }
  assert.deepEqual(JSON.parse(app.calls[2].init.body),{messageId:'draft-1',body:'Texto revisado',expectedBody:'Olá, Loja!'});
});
test('principal, missing account, invalid account, integration credentials and send methods never reach draft bridge',async t=>{
  const app=await harness(t);
  assert.equal((await app.call('GET',undefined,'principal')).status,403);
  assert.equal((await app.call('POST',{},null)).status,403);
  assert.equal((await app.call('GET',undefined,'missing')).status,404);
  assert.equal((await app.call('GET',undefined,support,{'X-Integration-Token':secret})).status,403);
  for(const method of ['DELETE','PUT']) assert.equal((await app.call(method,{})).status,405);
  assert.deepEqual(app.calls,[]);assert.deepEqual(app.connector,[]);
});
test('configured support ID takes precedence over the display name',async t=>{
  const app=await harness(t,{config:{prospectionAccountId:'missing'}});
  assert.equal((await app.call()).status,403);assert.deepEqual(app.calls,[]);
});
test('draft edits require valid optimistic guard before contacting prospection',async t=>{
  const app=await harness(t);
  for(const input of [{messageId:'draft-1',body:'Edit'}, {messageId:'',body:'Edit',expectedBody:'Old'}, {messageId:'draft-1',body:' ',expectedBody:'Old'}]) assert.equal((await app.call('PATCH',input)).status,422);
  assert.deepEqual(app.calls,[]);
});
test('offline, invalid JSON, redirect and upstream errors are readable and sanitized',async t=>{
  for(const upstream of [()=>{throw Error(secret);},()=>new Response('<html>'+secret+'</html>'),()=>new Response('',{status:302,headers:{location:'https://example.com'}}),()=>Response.json({error:secret},{status:500})]) {
    const app=await harness(t,{upstream}),response=await app.call();assert.equal(response.status,502);
    const data=await response.json();assert.match(data.error,/prospecção/i);assert.ok(!data.error.includes(secret));
  }
});
test('upstream edit conflict remains a conflict with safe local guidance',async t=>{
  const app=await harness(t,{upstream:()=>Response.json({error:secret},{status:409})});
  const response=await app.call('PATCH',{messageId:'draft-1',body:'Edit',expectedBody:'Old'});
  assert.equal(response.status,409);assert.match((await response.json()).error,/alterado|atualize/i);
});
