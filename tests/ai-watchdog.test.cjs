const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createAiWatchdog,isLocal}=require('../lib/ai-watchdog.cjs');
const {createLocalAi}=require('../lib/local-ai.cjs');
const {createWhatsAppServer}=require('../server.cjs');

// Ollama simulado: `online` diz se responde; `revive` pode religá-lo, falhar ou não ficar pronto.
function fixture({provider='ollama',baseUrl='',online=true,revives=true,embedding}={}) {
  let clock=1_000_000;const calls={running:0,revive:0},recovered=[];
  const local={online,async running() {calls.running++;return local.online;},async revive() {calls.revive++;if(revives instanceof Error) throw revives;if(revives) local.online=true;return local.online;}};
  const ai={config:async()=>({configured:true,provider,baseUrl}),embedding:async()=>embedding===undefined?(provider==='ollama'?{provider:'ollama',baseUrl}:null):embedding};
  const watchdog=createAiWatchdog({ai,localAi:local,onRecovered:()=>recovered.push(clock),now:()=>clock,retryMs:120_000});
  return {watchdog,local,calls,recovered,advance:ms=>{clock+=ms;}};
}

test('provedor na nuvem sem embeddings locais não é vigiado nem consulta o Ollama',async()=>{
  const f=fixture({provider:'openai',online:false,embedding:{provider:'openai',baseUrl:''}});
  await f.watchdog.check();
  assert.deepEqual([f.watchdog.status().watching,f.calls.running,f.calls.revive],[false,0,0]);
});

test('Ollama no ar: só confere, sem religar',async()=>{
  const f=fixture();await f.watchdog.check();
  assert.deepEqual([f.watchdog.status().watching,f.watchdog.status().running,f.calls.revive],[true,true,0]);
});

test('Ollama caído é religado uma vez, avisa a volta e zera o erro',async()=>{
  const f=fixture({online:false});await f.watchdog.check();
  const status=f.watchdog.status();
  assert.deepEqual([status.running,status.restarts,status.lastError,f.calls.revive,f.recovered.length],[true,1,'',1,1]);
});

test('falha ao religar fica visível e só tenta de novo depois do intervalo',async()=>{
  const f=fixture({online:false,revives:new Error('O Ollama não está instalado neste computador.')});
  await f.watchdog.check();
  let status=f.watchdog.status();
  assert.deepEqual([status.running,status.lastError,f.calls.revive],[false,'O Ollama não está instalado neste computador.',1]);
  assert.equal(Date.parse(status.nextAttemptAt)-Date.parse(status.since),120_000);
  f.advance(60_000);await f.watchdog.check();assert.equal(f.calls.revive,1,'Dentro do intervalo não tenta de novo.');
  f.advance(60_000);await f.watchdog.check();assert.equal(f.calls.revive,2);
  f.local.online=true;f.advance(10_000);await f.watchdog.check();
  status=f.watchdog.status();assert.deepEqual([status.running,status.lastError,f.recovered.length],[true,'',1],'Religado por fora, o vigia percebe e avisa.');
});

test('Ollama que inicia mas não responde fica marcado como fora do ar',async()=>{
  const f=fixture({online:false,revives:false});await f.watchdog.check();
  assert.deepEqual([f.watchdog.status().running,f.watchdog.status().lastError],[false,'O Ollama foi iniciado, mas não respondeu a tempo.']);
});

test('Anthropic com embeddings pelo Ollama local também é vigiado; endereço remoto não',async()=>{
  const anthropic=fixture({provider:'anthropic',online:false,embedding:{provider:'ollama',baseUrl:''}});
  await anthropic.watchdog.check();assert.equal(anthropic.calls.revive,1);
  const remote=fixture({baseUrl:'http://192.168.0.20:11434',online:false});
  await remote.watchdog.check();assert.deepEqual([remote.watchdog.status().watching,remote.calls.revive],[false,0]);
  assert.deepEqual(['','http://127.0.0.1:11434','http://localhost:11434/v1','http://127.0.0.1:9999','https://exemplo.com'].map(isLocal),[true,true,true,false,false]);
});

test('verificações simultâneas viram uma só e o vigia parado não age',async()=>{
  const f=fixture({online:false});
  await Promise.all([f.watchdog.check(),f.watchdog.check(),f.watchdog.check()]);assert.equal(f.calls.revive,1);
  const g=fixture({online:false});g.watchdog.stop();await g.watchdog.check();assert.equal(g.calls.running,0);
});

test('local-ai: religar inicia só o servidor, sem carregar modelo, e reaproveita o que já está no ar',async()=>{
  let online=false,launches=0;const routes=[];
  const service=createLocalAi({findExecutable:async()=>'C:/Ollama/ollama.exe',launch:async()=>{launches++;online=true;},delay:async()=>{},fetchImpl:async url=>{routes.push(new URL(url).pathname);if(!online) throw Error('ECONNREFUSED');return Response.json({version:'test'});}});
  assert.equal(await service.running(),false);
  assert.equal(await service.revive(),true);assert.equal(launches,1);
  assert.equal(await service.revive(),true);assert.equal(launches,1);
  assert.equal(routes.every(route=>route==='/api/version'),true,'Nenhum modelo é carregado.');
  const missing=createLocalAi({findExecutable:async()=>null,delay:async()=>{},fetchImpl:async()=>{throw Error('ECONNREFUSED');}});
  await assert.rejects(missing.revive(),/não está instalado/);
});

test('HTTP: /api/ai/health mostra o Ollama fora do ar e depois religado',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-watchdog-'));
  let online=false,launches=0;
  const localAi={running:async()=>online,revive:async()=>{launches++;return false;},status:async()=>({}),start:async()=>({})};
  const credentials=(()=>{const keys=new Map();return {has:async name=>keys.has(name),get:async name=>keys.get(name)||null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);},close:async()=>{}};})();
  await fs.writeFile(path.join(directory,'ai.json'),JSON.stringify({provider:'ollama',model:'qwen2.5:7b',baseUrl:'http://127.0.0.1:11434'}));
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:9',apiKey:'k',instanceName:'teste'},storeDir:directory,credentials,localAi,watchLocalAi:true,aiWatchdog:{intervalMs:20,retryMs:60_000},aiFetch:async()=>{throw Error('sem IA');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,token=(await (await fetch(base)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];
  const health=async()=>(await fetch(base+'/api/ai/health',{headers:{'X-WhatsApp-Token':token}})).json();
  const until=async predicate=>{for(let attempt=0;attempt<100;attempt++) {const value=await health();if(predicate(value)) return value;await new Promise(resolve=>setTimeout(resolve,20));}return health();};
  const down=await until(value=>value.running===false && value.lastError);
  assert.deepEqual([down.watching,down.running,launches>=1,typeof down.search?.mode],[true,false,true,'string']);
  assert.match(down.lastError,/não respondeu/);
  online=true;
  const back=await until(value=>value.running===true);
  assert.equal(back.lastError,'');assert.equal(launches,1,'Dentro do intervalo, o vigia não religa de novo.');
  assert.equal((await fetch(base+'/api/ai/health')).status,403,'Sem o token da sessão, a rota é recusada.');
});
