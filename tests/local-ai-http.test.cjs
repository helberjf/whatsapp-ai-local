const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createWhatsAppServer}=require('../server.cjs');
test('local AI launch is authenticated, saves local provider only after readiness and preserves auto-reply switches',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-ai-http-'));let starts=0,fail=false;
  const state={installed:true,running:true,loaded:true,modelInstalled:true,model:'test-local',models:['test-local']},credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({storeDir:directory,credentials,disableWorkers:true,config:{apiUrl:'http://127.0.0.1:9999',apiKey:'fixture',instanceName:'test'},fetchImpl:async()=>Response.json({}),localAi:{status:async()=>state,start:async()=>{starts++;if(fail) throw Object.assign(new Error('Modelo indisponível'),{status:409});return state;}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^whatsapp-local-ai-http-/);await fs.rm(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port,html=await(await fetch(base)).text(),token=html.match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1],headers={'X-WhatsApp-Token':token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/ai/local/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.equal(starts,0);
  assert.equal((await fetch(base+'/api/ai/local',{headers})).status,200);assert.equal(starts,0);
  const start=await fetch(base+'/api/ai/local/start',{method:'POST',headers,body:JSON.stringify({model:'test-local'})});assert.equal(start.status,200);assert.equal(starts,1);const result=await start.json();assert.equal(result.config.provider,'ollama');assert.equal(result.config.baseUrl,'http://127.0.0.1:11434');assert.equal(result.config.apiKey,undefined);
  const assistant=await(await fetch(base+'/api/assistant',{headers})).json();assert.equal(assistant.enabled,false);
  const cpu=await(await fetch(base+'/api/ai/local/start',{method:'POST',headers,body:JSON.stringify({model:'test-local',device:'cpu'})})).json();assert.equal(cpu.config.ollamaNumGpu,0);
  fail=true;const failed=await fetch(base+'/api/ai/local/start',{method:'POST',headers,body:JSON.stringify({model:'not-installed'})});assert.equal(failed.status,409);const saved=await(await fetch(base+'/api/ai',{headers})).json();assert.equal(saved.model,'test-local');
});
