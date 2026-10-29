const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createAi}=require('../lib/ai.cjs');
const {createCredentialStore}=require('../lib/credentials.cjs');
const protectedOptions={protect:async bytes=>Buffer.from('protected:'+bytes.toString('base64')),unprotect:async bytes=>Buffer.from(bytes.toString().slice(10),'base64')};
async function fixture(t,{legacy,credentials,fetchImpl}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-ai-key-test-'));if(legacy) await fs.writeFile(path.join(directory,'ai.json'),JSON.stringify(legacy));
  const vault=credentials || createCredentialStore(directory,protectedOptions),seen=[];
  const ai=createAi(directory,fetchImpl || (async(url,options)=>{seen.push({url,options});return Response.json({choices:[{message:{content:'ok'}}]});}),{credentials:vault});
  t.after(async()=>{await ai.close?.();await vault.close?.();await fs.rm(directory,{recursive:true,force:true});});return {directory,vault,ai,seen,metadata:async()=>JSON.parse(await fs.readFile(path.join(directory,'ai.json'),'utf8'))};
}
test('IA guarda chave no cofre, mantém apenas metadados no JSON e usa autenticação correta',async t=>{
  const f=await fixture(t);const view=await f.ai.save({provider:'openai',model:'test-model',apiKey:'sk-PRIVATE'});assert.equal(view.hasKey,true);assert.equal(view.configured,true);assert.doesNotMatch(JSON.stringify(view),/sk-PRIVATE|apiKey/);
  assert.equal(Object.hasOwn(await f.metadata(),'apiKey'),false);assert.equal(await f.vault.get('assistant'),'sk-PRIVATE');assert.equal(await f.vault.has('openai'),false);
  await f.ai.complete({system:'Teste',user:'Olá'});assert.equal(f.seen[0].options.headers.Authorization,'Bearer sk-PRIVATE');
});
test('IA migra chave antiga somente após verificar proteção e funciona após reinício',async t=>{
  const legacy={provider:'anthropic',model:'claude-test',baseUrl:'',apiKey:'claude-PRIVATE'},f=await fixture(t,{legacy,fetchImpl:async()=>Response.json({content:[{type:'text',text:'ok'}]})});
  const view=await f.ai.config();assert.equal(view.hasKey,true);assert.equal(await f.vault.get('assistant'),'claude-PRIVATE');assert.equal(Object.hasOwn(await f.metadata(),'apiKey'),false);
  const restartedVault=createCredentialStore(f.directory,protectedOptions),restarted=createAi(f.directory,async(url,options)=>{assert.equal(options.headers['x-api-key'],'claude-PRIVATE');return Response.json({content:[{type:'text',text:'ok'}]});},{credentials:restartedVault});
  try {assert.equal((await restarted.config()).configured,true);assert.equal(await restarted.complete({system:'Teste',user:'Olá'}),'ok');}finally {await restarted.close();await restartedVault.close();}
});
test('migração que falha não apaga chave antiga nem expõe segredo e pode tentar novamente',async t=>{
  let fail=true,value=null;const credentials={has:async()=>!!value,set:async(name,key)=>{if(fail) throw new Error('VAULT-PRIVATE');value=key;},get:async()=>value,remove:async()=>{value=null;}};
  const f=await fixture(t,{legacy:{provider:'openai',model:'test',apiKey:'legacy-PRIVATE'},credentials});await assert.rejects(f.ai.config(),error=>error.status===503&&!/PRIVATE/.test(error.message));assert.equal((await f.metadata()).apiKey,'legacy-PRIVATE');
  fail=false;assert.equal((await f.ai.config()).configured,true);assert.equal(Object.hasOwn(await f.metadata(),'apiKey'),false);
});
test('migração exige leitura de conferência antes de retirar o texto antigo',async t=>{
  const credentials={has:async()=>false,set:async()=>{},get:async()=>null,remove:async()=>{}};
  const f=await fixture(t,{legacy:{provider:'openai',model:'test',apiKey:'legacy-PRIVATE'},credentials});await assert.rejects(f.ai.config(),error=>error.status===503);assert.equal((await f.metadata()).apiKey,'legacy-PRIVATE');
});
test('rotação, preservação de chave vazia e exclusão explícita não gravam texto da chave',async t=>{
  const f=await fixture(t);await f.ai.save({provider:'openai',model:'test',apiKey:'first-PRIVATE'});await f.ai.save({provider:'anthropic',model:'other',apiKey:''});assert.equal(await f.vault.get('assistant'),'first-PRIVATE');
  await f.ai.save({provider:'gemini',model:'next',apiKey:'second-PRIVATE'});assert.equal(await f.vault.get('assistant'),'second-PRIVATE');assert.equal((await f.ai.save({provider:'gemini',model:'next',clearKey:true})).configured,false);assert.equal(await f.vault.has('assistant'),false);assert.doesNotMatch(JSON.stringify(await f.metadata()),/PRIVATE|apiKey/);
});
test('configuração consulta só existência sem descriptografar e fechar IA não fecha cofre compartilhado',async t=>{
  let gets=0,closed=0;const credentials={has:async()=>true,get:async()=>{gets++;return 'PRIVATE';},set:async()=>{},remove:async()=>{},close:async()=>{closed++;}};
  const f=await fixture(t,{credentials});await f.ai.save({provider:'openai',model:'test'});await f.ai.config();await f.ai.config();assert.equal(gets,0);assert.equal(typeof f.ai.close,'function');await f.ai.close();assert.equal(closed,0);
});
test('falhas de provedor, conexão e abertura de credencial não refletem segredos',async t=>{
  for(const fetchImpl of [async()=>Response.json({error:{message:'Bearer key-PRIVATE'}},{status:401}),async()=>{throw new Error('key-PRIVATE');},async()=>({ok:false,status:500,text:async()=>{throw new Error('key-PRIVATE');}})]) {
    const f=await fixture(t,{fetchImpl});await f.ai.save({provider:'openai',model:'test',apiKey:'key-PRIVATE'});await assert.rejects(f.ai.complete({system:'Teste',user:'Olá'}),error=>!error.message.includes('PRIVATE'));
  }
  const f=await fixture(t,{credentials:{has:async()=>true,get:async()=>{throw new Error('PRIVATE');},set:async()=>{},remove:async()=>{}}});await f.ai.save({provider:'anthropic',model:'test'});await assert.rejects(f.ai.complete({system:'Teste',user:'Olá'}),error=>error.status===503&&!error.message.includes('PRIVATE'));assert.equal(f.seen.length,0);
});

test('configuração antiga usa seleção automática de hardware por padrão',async t=>{
  const f=await fixture(t,{legacy:{provider:'ollama',model:'test-local',baseUrl:''}});assert.equal((await f.ai.config()).ollamaNumGpu,null);
});

test('preferência CPU do Ollama persiste após reinício e só envia a opção local sem chave',async t=>{
  const f=await fixture(t);await f.ai.save({provider:'openai',model:'test',apiKey:'sk-PRIVATE'});
  const saved=await f.ai.save({provider:'ollama',model:'test-local',ollamaNumGpu:0});assert.equal(saved.ollamaNumGpu,0);assert.equal((await f.metadata()).ollamaNumGpu,0);assert.doesNotMatch(JSON.stringify(saved),/sk-PRIVATE|apiKey/);assert.doesNotMatch(JSON.stringify(await f.metadata()),/sk-PRIVATE|apiKey/);
  const seen=[],restarted=createAi(f.directory,async(url,options)=>{seen.push({url,options});return Response.json({message:{content:'ok'}});},{credentials:f.vault});
  try {assert.equal((await restarted.config()).ollamaNumGpu,0);assert.equal(await restarted.complete({system:'Teste',user:'Olá'}),'ok');const request=seen[0],body=JSON.parse(request.options.body);assert.equal(request.url,'http://127.0.0.1:11434/api/chat');assert.equal(body.options.num_gpu,0);assert.equal(request.options.headers.Authorization,undefined);assert.doesNotMatch(JSON.stringify(request),/sk-PRIVATE/);}finally {await restarted.close();}
});

test('salvar o mesmo modelo mantém CPU e seleção automática explícita retira a opção',async t=>{
  const seen=[],f=await fixture(t,{fetchImpl:async(url,options)=>{seen.push(JSON.parse(options.body));return Response.json({message:{content:'ok'}});}});
  await f.ai.save({provider:'ollama',model:'test-local',ollamaNumGpu:0});assert.equal((await f.ai.save({provider:'ollama',model:'test-local'})).ollamaNumGpu,0);
  assert.equal((await f.ai.save({provider:'ollama',model:'test-local',ollamaNumGpu:null})).ollamaNumGpu,null);assert.equal((await f.metadata()).ollamaNumGpu,null);await f.ai.complete({system:'Teste',user:'Olá'});assert.equal(Object.hasOwn(seen[0].options,'num_gpu'),false);
});

test('trocar modelo ou provedor limpa CPU salvo e nunca aplica a opção a outro provedor',async t=>{
  const f=await fixture(t);await f.ai.save({provider:'ollama',model:'first',ollamaNumGpu:0});assert.equal((await f.ai.save({provider:'ollama',model:'second'})).ollamaNumGpu,null);
  assert.equal((await f.ai.save({provider:'ollama',model:'third',ollamaNumGpu:0})).ollamaNumGpu,0);
  assert.equal((await f.ai.save({provider:'custom',model:'third',baseUrl:'https://example.test/v1',ollamaNumGpu:0})).ollamaNumGpu,null);await f.ai.complete({system:'Teste',user:'Olá'});assert.equal(JSON.parse(f.seen[0].options.body).options,undefined);
  assert.equal((await f.ai.save({provider:'ollama',model:'third'})).ollamaNumGpu,null);
});

test('seleção de hardware rejeita opções diferentes de CPU zero ou automático nulo',async t=>{
  const f=await fixture(t);for(const ollamaNumGpu of [1,-1,'0',false,{},[]])await assert.rejects(f.ai.save({provider:'ollama',model:'test-local',ollamaNumGpu}),error=>error.status===422);assert.equal(f.seen.length,0);
});
