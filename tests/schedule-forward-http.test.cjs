const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../server.cjs');
test('agenda autenticada cria, altera, cancela e executa no servidor sem repetir envio',async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.base+'/api/scheduled-messages')).status,403);
  const created=await f.req('/scheduled-messages','POST',{jid:f.target,text:'Texto futuro',scheduledAt:new Date(f.now()+60000).toISOString(),requestId:'schedule-http-001'});assert.equal(created.status,201);const job=await created.json();assert.equal(job.status,'scheduled');assert.equal(job.requestHash,undefined);assert.equal(f.sends.length,0);
  const edited=await f.req('/scheduled-messages/'+job.id,'PATCH',{text:'Mensagem revisada'});assert.equal(edited.status,200);assert.equal((await edited.json()).text,'Mensagem revisada');
  const cancelled=await f.req('/scheduled-messages/'+job.id+'/cancel','POST',{});assert.equal((await cancelled.json()).status,'cancelled');f.advance(61000);await f.server.scheduler.tick();assert.equal(f.sends.length,0);
  await f.req('/scheduled-messages/'+job.id,'PATCH',{scheduledAt:new Date(f.now()+60000).toISOString()});f.advance(61000);await f.server.scheduler.tick();assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,'Mensagem revisada');
  const list=await(await f.req('/scheduled-messages')).json();assert.equal(list[0].status,'sent');await f.server.scheduler.tick();assert.equal(f.sends.length,1);
});
test('encaminhamento busca original, exige confirmação via POST e usa deduplicação existente',async t=>{
  const f=await fixture(t);const input={sourceJid:f.source,messageId:'original-1',targetJid:f.target,requestId:'forward-http-001'};
  assert.equal((await fetch(f.base+'/api/forward',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
  await Promise.all([f.req('/forward','POST',input),f.req('/forward','POST',input)]);assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,'Texto original');assert.equal(f.sends[0].number,f.target);
  assert.equal((await f.req('/forward','POST',{...input,targetJid:'123@g.us'})).status,422);
  assert.equal((await f.req('/forward','POST',{...input,messageId:'outro-id'})).status,409);
  const sync=await f.req('/contacts/sync','POST',{});assert.equal(sync.status,200);assert.equal(typeof(await sync.json()).named,'number');
});
test('falha ao ler a origem permite tentar de novo sem reservar um envio que não começou',async t=>{
  const f=await fixture(t),input={sourceJid:f.source,messageId:'original-1',targetJid:f.target,requestId:'forward-source-001'};
  f.failSource(true);assert.equal((await f.req('/forward','POST',input)).status,502);assert.equal(f.sends.length,0);
  f.failSource(false);assert.equal((await f.req('/forward','POST',input)).status,200);assert.equal(f.sends.length,1);
  assert.equal((await f.req('/forward','POST',input)).status,200);assert.equal(f.sends.length,1);
});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-schedule-http-')),source='5511998765432@s.whatsapp.net',target='5521998765432@s.whatsapp.net',sends=[];let clock=Date.parse('2026-10-29T12:00:00Z'),sourceUnavailable=false;
  const server=createWhatsAppServer({storeDir:directory,now:()=>clock,config:{apiUrl:'http://127.0.0.1:9999',apiKey:'private',instanceName:'teste'},fetchImpl:async(url,options)=>{
    const input=options.body?JSON.parse(options.body):{};let output={};
    if(String(url).includes('/findMessages/') && sourceUnavailable) return new Response('{}',{status:503});
    if(String(url).includes('/connectionState/')) output={instance:{state:'open'}};
    else if(String(url).includes('/fetchInstances')) output=[{name:'teste',ownerJid:source}];
    else if(String(url).includes('/findContacts/')) output=[];
    else if(String(url).includes('/findMessages/')) output={messages:{records:[{key:{id:'original-1',remoteJid:source,fromMe:false},message:{conversation:'Texto original'},messageTimestamp:1793275200}],currentPage:1,pages:1}};
    else if(String(url).includes('/sendText/')) {sends.push(input);output={key:{id:'sent-1',remoteJid:input.number,fromMe:true},message:{conversation:input.text}};}
    return new Response(JSON.stringify(output));
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,token=(await(await fetch(base)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];
  t.after(async()=>{await new Promise(r=>server.close(r));await server.scheduler.idle();assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^wa-schedule-http-/);await fs.rm(directory,{recursive:true,force:true});});
  return {base,server,sends,source,target,now:()=>clock,advance:ms=>clock+=ms,failSource:value=>sourceUnavailable=value,req:(route,method='GET',input)=>fetch(base+'/api'+route,{method,headers:{'X-WhatsApp-Token':token,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})})};
}
