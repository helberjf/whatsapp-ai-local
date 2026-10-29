const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../server.cjs');
test('CRM, robô e avatar têm rotas autenticadas; CRM novo preserva metadados da conversa',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-features-http-')),jid='5511998765432@s.whatsapp.net',calls=[];
  const server=createWhatsAppServer({storeDir:directory,config:{apiUrl:'http://127.0.0.1:9999',apiKey:'private',instanceName:'teste'},fetchImpl:async(url,options)=>{
    calls.push(String(url));return new Response(JSON.stringify(String(url).includes('fetchProfilePictureUrl')?{profilePictureUrl:null}:[{remoteJid:jid,pushName:'Teste'}]));
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^wa-features-http-/);await fs.rm(directory,{recursive:true,force:true});});
  const token=(await(await fetch(base)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];
  const req=(route,method='GET',body)=>fetch(base+'/api'+route,{method,headers:{'X-WhatsApp-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await fetch(base+'/api/automation/settings')).status,403);
  const initial=await req('/automation/settings');assert.equal(initial.status,200);assert.equal((await initial.json()).enabled,false);
  const rule={name:'Horário',keywords:['horario'],match:'word',response:'Abro às 9h.',enabled:true};
  assert.equal((await req('/automation/settings','PATCH',{rules:[rule]})).status,200);
  const simulated=await(await req('/automation/simulate','POST',{text:'Qual o horário?'})).json();assert.equal(simulated.reply,rule.response);assert.equal(calls.some(url=>url.includes('sendText')),false);
  assert.deepEqual(await(await req('/automation/executions')).json(),[]);
  assert.equal((await req('/crm?jid='+encodeURIComponent(jid),'PATCH',{stage:'contacted',automationPaused:true})).status,200);
  const board=await(await req('/crm')).json();assert.equal(board.contacts[0].crm.stage,'contacted');assert.equal(board.contacts[0].automationPaused,true);
  const contact=await(await req('/contact?jid='+encodeURIComponent(jid))).json();assert.deepEqual(contact.labels,[]);assert.deepEqual(contact.notes,[]);assert.equal(contact.status,'open');
  const chat=(await(await req('/chats')).json())[0];assert.deepEqual(chat.labels,[]);assert.equal(chat.status,'open');
  assert.equal((await req('/notes','POST',{jid,text:'Nota após CRM.'})).status,201);
  assert.deepEqual(await(await req('/avatar?jid='+encodeURIComponent(jid))).json(),{base64:null,mimeType:null});
});
