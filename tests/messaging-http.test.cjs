const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createDemo}=require('../scripts/demo.cjs');

test('new messaging routes authenticate, preserve explicit actions and accept bounded sticker payloads',async t=>{
  const demo=await createDemo({port:0});t.after(()=>demo.close());
  const token=(await(await fetch(demo.base)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];
  const req=(route,input,method=input===undefined?'GET':'POST')=>fetch(demo.base+'/api'+route,{method,headers:{'X-WhatsApp-Token':token,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
  assert.equal((await fetch(demo.base+'/api/triggers')).status,403);
  assert.equal((await req('/triggers')).status,200);assert.equal((await(await req('/triggers')).json()).enabled,false);
  assert.equal((await req('/triggers',{enabled:'yes'},'PUT')).status,422);
  const jid='5511000000000@s.whatsapp.net';
  const details=await(await req('/contact/details?jid='+encodeURIComponent(jid))).json();assert.equal(details.name,'Alex Morgan');assert.equal(details.capabilities.disappearingMessages,true);
  assert.equal((await req('/messages/disappearing',{jid,expiration:3600})).status,422);
  assert.equal((await req('/messages/disappearing',{jid,expiration:86400})).status,200);
  assert.equal((await req('/messages/delete',{jid,messageId:'demo-audio',requestId:'delete-incoming-1'})).status,422);
  const bytes=Buffer.alloc(400000);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const sticker={jid,mimeType:'image/png',base64:bytes.toString('base64'),requestId:'sticker-valid-001'};
  assert.equal((await req('/send-sticker',sticker)).status,200,'A large valid base64 string must not overflow the RegExp stack.');
  assert.equal((await req('/send-sticker',{...sticker,requestId:'sticker-invalid-1',mimeType:'text/html'})).status,422);
  assert.equal((await req('/send-sticker',{...sticker,requestId:'sticker-caption-1',caption:'Not supported'})).status,422);
});
