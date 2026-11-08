const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createAi}=require('../lib/ai.cjs');
const {createCredentialStore}=require('../lib/credentials.cjs');
async function fixture(t,fetchImpl) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-ai-models-'));
  const credentials=createCredentialStore(directory,{protect:async bytes=>Buffer.from(bytes.toString('base64')),unprotect:async bytes=>Buffer.from(bytes.toString(),'base64')});
  const ai=createAi(directory,fetchImpl,{credentials});
  t.after(async()=>{await ai.close();await credentials.close();await fs.rm(directory,{recursive:true,force:true});});
  return {ai,credentials,directory};
}
test('catálogo oferece provedores, sugestões e estado independente de chave',async t=>{
  const {ai}=await fixture(t);const config=await ai.config();
  for(const id of ['openai','anthropic','gemini','deepseek','groq','mistral','xai','openrouter','together','perplexity','ollama','custom']) {
    assert.ok(config.providers[id],id);assert.ok(Array.isArray(config.providers[id].models));assert.equal(config.providers[id].hasKey,false);
  }
});
test('cada provedor mantém sua chave e remoção não altera outro serviço',async t=>{
  const requests=[],{ai}=await fixture(t,async(url,options)=>{requests.push({url,options});return Response.json({choices:[{message:{content:'ok'}}]});});
  await ai.save({provider:'openai',model:'test',apiKey:'sk-OPENAI-PRIVATE'});
  assert.equal((await ai.save({provider:'deepseek',model:'test'})).configured,false);
  await ai.save({provider:'deepseek',model:'test',apiKey:'sk-DEEPSEEK-PRIVATE'});await ai.complete({system:'Teste',user:'Olá'});
  assert.equal(requests[0].options.headers.Authorization,'Bearer sk-DEEPSEEK-PRIVATE');
  const config=await ai.save({provider:'openai',model:'test'});assert.equal(config.hasKey,true);assert.equal(config.providers.deepseek.hasKey,true);
  await ai.complete({system:'Teste',user:'Olá'});assert.equal(requests[1].options.headers.Authorization,'Bearer sk-OPENAI-PRIVATE');
  assert.equal((await ai.save({provider:'openai',model:'test',clearKey:true})).hasKey,false);
  assert.equal((await ai.save({provider:'deepseek',model:'test'})).hasKey,true);
});
test('consulta usa chave colada sem salvá-la, filtra modelos não conversacionais e preserva configuração',async t=>{
  const requests=[],{ai,credentials}=await fixture(t,async(url,options)=>{requests.push({url:String(url),options});return Response.json({data:[{id:'gpt-chat'},{id:'gpt-chat'},{id:'text-embedding-3-small'},{id:'whisper-1'},{id:'gpt-audio'},{id:'dall-e-3'}]});});
  const result=await ai.models({provider:'openai',apiKey:'sk-UNSAVED-PRIVATE'});
  assert.deepEqual(result.models.map(item=>item.id),['gpt-chat']);assert.equal(result.provider,'openai');
  assert.equal(requests[0].url,'https://api.openai.com/v1/models');assert.equal(requests[0].options.headers.Authorization,'Bearer sk-UNSAVED-PRIVATE');assert.equal(requests[0].options.redirect,'error');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.equal((await ai.config()).hasKey,false);assert.equal(await credentials.has('assistant:openai'),false);
});
test('consulta Gemini percorre páginas e inclui apenas generateContent de texto',async t=>{
  const requests=[],{ai}=await fixture(t,async(url,options)=>{requests.push({url:String(url),options});return Response.json(requests.length===1?{models:[{name:'models/gemini-chat',displayName:'Gemini Chat',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'next-page'}:{models:[{name:'models/gemini-other',supportedGenerationMethods:['generateContent']},{name:'models/gemini-image',supportedGenerationMethods:['generateContent']}]});});
  const result=await ai.models({provider:'gemini',apiKey:'GEMINI-PRIVATE'});assert.deepEqual(result.models.map(item=>item.id),['gemini-chat','gemini-other']);assert.match(requests[1].url,/pageToken=next-page/);assert.equal(requests[0].options.headers['x-goog-api-key'],'GEMINI-PRIVATE');assert.doesNotMatch(requests[0].url,/PRIVATE/);
});
test('consulta Anthropic pagina com cursor e usa apenas a chave desse provedor',async t=>{
  const requests=[],{ai}=await fixture(t,async(url,options)=>{requests.push({url:String(url),options});return Response.json(requests.length===1?{data:[{id:'claude-first',display_name:'Claude First'}],has_more:true,last_id:'claude-first'}:{data:[{id:'claude-second'}],has_more:false});});
  await ai.save({provider:'anthropic',model:'claude-first',apiKey:'CLAUDE-PRIVATE'});const result=await ai.models({provider:'anthropic'});
  assert.equal(result.models.length,2);assert.match(requests[1].url,/after_id=claude-first/);assert.equal(requests[0].options.headers['x-api-key'],'CLAUDE-PRIVATE');
});
test('consulta local não envia chaves e APIs compatíveis aceitam lista sem autenticação',async t=>{
  const requests=[],{ai}=await fixture(t,async(url,options)=>{requests.push({url:String(url),options});return Response.json(String(url).includes('/api/tags')?{models:[{name:'qwen-local'},{name:'remote-cloud',remote_host:'example.test'}]}:{data:[{id:'private-model'}]});});
  await ai.save({provider:'openai',model:'test',apiKey:'OPENAI-PRIVATE'});
  assert.deepEqual((await ai.models({provider:'ollama'})).models.map(item=>item.id),['qwen-local']);assert.equal(requests[0].options.headers.Authorization,undefined);
  assert.equal((await ai.models({provider:'custom',baseUrl:'http://localhost:1234/v1'})).models[0].id,'private-model');assert.equal(requests[1].options.headers.Authorization,undefined);
  assert.equal((await ai.config()).provider,'openai');
});
test('consulta não envia chave salva para um endereço diferente e sanitiza falhas',async t=>{
  let calls=0;const {ai}=await fixture(t,async()=>{calls++;return Response.json({error:{message:'sk-PRIVATE'}},{status:401});});await ai.save({provider:'openai',model:'test',apiKey:'sk-PRIVATE'});
  await assert.rejects(ai.models({provider:'openai',baseUrl:'https://another.example/v1'}),error=>error.status===409);assert.equal(calls,0);
  await assert.rejects(ai.models({provider:'openai'}),error=>!error.message.includes('PRIVATE'));assert.equal(calls,1);
  for(const input of [null,{provider:'constructor'},{provider:'openai',apiKey:'bad key'},{provider:'custom',baseUrl:'file:///test'}])await assert.rejects(ai.models(input),error=>error.status===422);
});
test('migra credencial antiga do SQLite para o provedor atual sem manter cópia compartilhada',async t=>{
  const {ai,credentials,directory}=await fixture(t);await fs.writeFile(path.join(directory,'ai.json'),JSON.stringify({provider:'gemini',model:'test',baseUrl:''}));await credentials.set('assistant','LEGACY-PRIVATE');
  assert.equal((await ai.config()).hasKey,true);assert.equal(await credentials.get('assistant:gemini'),'LEGACY-PRIVATE');assert.equal(await credentials.has('assistant'),false);
  assert.equal((await ai.save({provider:'openai',model:'test'})).hasKey,false);
});
test('modelo OpenAI de raciocínio não recebe temperatura fixa incompatível',async t=>{
  let body;const {ai}=await fixture(t,async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:'ok'}}]});});await ai.save({provider:'openai',model:'gpt-5',apiKey:'sk-PRIVATE'});await ai.complete({system:'Teste',user:'Olá'});assert.equal(body.temperature,undefined);assert.equal(body.max_completion_tokens,2000);
});
test('chave antiga sem provedor conhecido permanece isolada após sair do Ollama e reiniciar',async t=>{
  const {ai,credentials,directory}=await fixture(t);await fs.writeFile(path.join(directory,'ai.json'),JSON.stringify({provider:'ollama',model:'local',baseUrl:''}));await credentials.set('assistant','UNKNOWN-PRIVATE');
  assert.equal((await ai.config()).hasKey,false);assert.equal((await ai.save({provider:'openai',model:'test'})).hasKey,false);
  const restarted=createAi(directory,undefined,{credentials});try {assert.equal((await restarted.config()).hasKey,false);}finally {await restarted.close();}
});
test('migração exige verificar chave protegida mesmo se já existir uma linha no banco',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-ai-migration-'));await fs.writeFile(path.join(directory,'ai.json'),JSON.stringify({provider:'openai',model:'test',apiKey:'legacy-PRIVATE'}));
  const ai=createAi(directory,undefined,{credentials:{has:async name=>name==='assistant:openai',get:async()=>{throw new Error('PRIVATE');},set:async()=>{},remove:async()=>{}}});
  t.after(async()=>{await ai.close();await fs.rm(directory,{recursive:true,force:true});});await assert.rejects(ai.config(),error=>error.status===503);assert.equal(JSON.parse(await fs.readFile(path.join(directory,'ai.json'),'utf8')).apiKey,'legacy-PRIVATE');
});
test('vínculo da chave com endereço persiste ao trocar provedor e reiniciar',async t=>{
  const requests=[],fetchImpl=async(url,options)=>{requests.push({url,options});return Response.json({data:[{id:'gpt-chat'}]});},f=await fixture(t,fetchImpl);
  await f.ai.save({provider:'openai',model:'gpt-chat',baseUrl:'https://proxy.example/v1',apiKey:'PROXY-PRIVATE'});await f.ai.save({provider:'gemini',model:'gemini-chat'});
  await assert.rejects(f.ai.models({provider:'openai'}),error=>error.status===409);assert.equal(requests.length,0);
  await assert.rejects(f.ai.save({provider:'openai',model:'gpt-chat'}),error=>error.status===409);assert.equal((await f.ai.config()).provider,'gemini');
  const restarted=createAi(f.directory,fetchImpl,{credentials:f.credentials});try {await assert.rejects(restarted.models({provider:'openai'}),error=>error.status===409);assert.equal(requests.length,0);assert.equal((await restarted.models({provider:'openai',baseUrl:'https://proxy.example/v1'})).models.length,1);assert.equal(requests[0].options.headers.Authorization,'Bearer PROXY-PRIVATE');}finally {await restarted.close();}
});
test('migração não remove credencial compartilhada quando destino existente não pode ser aberto',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-ai-migration-'));let removed=false;
  const ai=createAi(directory,undefined,{credentials:{has:async name=>['assistant','assistant:openai'].includes(name),get:async()=>{throw new Error('PRIVATE');},set:async()=>{},remove:async()=>{removed=true;}}});
  t.after(async()=>{await ai.close();await fs.rm(directory,{recursive:true,force:true});});await assert.rejects(ai.config(),error=>error.status===503);assert.equal(removed,false);
});
test('remover chave de provedor inativo dispensa modelo e preserva configuração ativa',async t=>{
  const {ai}=await fixture(t);await ai.save({provider:'groq',model:'private-chat',apiKey:'GROQ-PRIVATE'});await ai.save({provider:'openai',model:'gpt-chat',apiKey:'OPENAI-PRIVATE'});
  const config=await ai.removeKey({provider:'groq'});assert.equal(config.provider,'openai');assert.equal(config.model,'gpt-chat');assert.equal(config.hasKey,true);assert.equal(config.providers.groq.hasKey,false);
});
