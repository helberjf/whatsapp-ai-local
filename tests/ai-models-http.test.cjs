const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../server.cjs');
test('catálogo exige autenticação, consulta não persiste segredo e salvar usa SQLite criptografado',{skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-ai-http-')),requests=[];
  const options={storeDir:directory,disableWorkers:true,config:{apiUrl:'http://127.0.0.1:9999',apiKey:'fixture',instanceName:'test'},fetchImpl:async()=>Response.json({}),aiFetch:async(url,input)=>{requests.push({url:String(url),input});return Response.json({data:[{id:'gpt-chat',owned_by:'SECRET-METADATA'}]});}};
  let server;
  const close=async()=>{if(server) {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;server=null;}};
  t.after(async()=>{await close();await fs.rm(directory,{recursive:true,force:true});});
  async function start() {server=createWhatsAppServer(options);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,token=(await(await fetch(base)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];return {base,req:(route,method='GET',body)=>fetch(base+'/api'+route,{method,headers:{'X-WhatsApp-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})};}
  let client=await start();
  assert.equal((await fetch(client.base+'/api/ai/models',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.equal(requests.length,0);
  const secret='sk-PRIVATE-HTTP-'+Date.now(),query=await client.req('/ai/models','POST',{provider:'openai',apiKey:secret});assert.equal(query.status,200);assert.doesNotMatch(JSON.stringify(await query.json()),/PRIVATE|SECRET-METADATA/);assert.equal((await(await client.req('/ai')).json()).hasKey,false);
  const save=await client.req('/ai','PUT',{provider:'openai',model:'gpt-chat',apiKey:secret});assert.equal(save.status,200);assert.doesNotMatch(JSON.stringify(await save.json()),/PRIVATE|apiKey/);
  assert.equal((await fs.readFile(path.join(directory,'credentials.sqlite'))).includes(Buffer.from(secret)),false);assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(directory,'ai.json'),'utf8')),'apiKey'),false);
  await close();client=await start();const restored=await(await client.req('/ai')).json();assert.equal(restored.hasKey,true);assert.equal(restored.providers.openai.hasKey,true);
  assert.equal((await client.req('/ai/models','POST',{provider:'openai'})).status,200);assert.equal(requests.at(-1).input.headers.Authorization,'Bearer '+secret);
});
