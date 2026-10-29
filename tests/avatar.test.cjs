const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAvatarService}=require('../lib/avatars.cjs');
const jid='5511998765432@s.whatsapp.net';
test('fotos usam apenas CDN WhatsApp HTTPS, cache e deduplicação',async()=>{
  let profiles=0,downloads=0;
  const avatars=createAvatarService({profileLoader:async value=>{assert.equal(value,jid);profiles++;return {profilePictureUrl:'https://pps.whatsapp.net/v/t61/photo.jpg'};},fetchImpl:async(url,options)=>{downloads++;assert.equal(options.redirect,'error');return new Response(Buffer.from([255,216,255]),{headers:{'Content-Type':'image/jpeg'}});}});
  const [a,b]=await Promise.all([avatars.get(jid),avatars.get(jid)]);assert.deepEqual(a,b);assert.equal(a.mimeType,'image/jpeg');assert.equal(profiles,1);assert.equal(downloads,1);await avatars.get(jid);assert.equal(downloads,1);
});
test('foto privada ou URL externa mantém avatar com iniciais sem buscar outros endereços',async()=>{
  for(const url of [null,'http://127.0.0.1/private','https://evil.example/a','https://pps.whatsapp.net.evil.example/a','https://user:pass@pps.whatsapp.net/a']) {
    const avatars=createAvatarService({profileLoader:async()=>({profilePictureUrl:url}),fetchImpl:()=>assert.fail('não buscar URL externa')});
    assert.deepEqual(await avatars.get(jid),{base64:null,mimeType:null});
  }
});
test('rejeita grupo, HTML e foto grande sem expor dados externos',async()=>{
  const avatars=createAvatarService({profileLoader:async()=>({profilePictureUrl:'https://pps.whatsapp.net/a'}),fetchImpl:async()=>new Response('html',{headers:{'Content-Type':'text/html'}})});
  assert.throws(()=>avatars.get('123@g.us'),{status:422});assert.equal((await avatars.get(jid)).base64,null);
  const large=createAvatarService({profileLoader:async()=>({profilePictureUrl:'https://pps.whatsapp.net/a'}),fetchImpl:async()=>new Response(Buffer.alloc(1024*1024+1),{headers:{'Content-Type':'image/png'}})});assert.equal((await large.get(jid)).base64,null);
});
