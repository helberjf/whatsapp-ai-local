const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createEvolutionClient}=require('../lib/evolution.cjs');
test('large received video bypasses the ordinary JSON limit only on the media route',async()=>{
  const base64=Buffer.alloc(13*1024*1024).toString('base64');
  const client=createEvolutionClient({apiUrl:'http://127.0.0.1:9999',apiKey:'test',instanceName:'test'},async()=>new Response(JSON.stringify({base64,mimetype:'video/mp4'})));
  assert.equal((await client.media('5511999999999@s.whatsapp.net','video')).base64.length,base64.length);
  assert.equal((await client.connection()).state,'unreachable');
});
