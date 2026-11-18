const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createAi}=require('../lib/ai.cjs');
const {createCredentialStore}=require('../lib/credentials.cjs');
const {normalizeBudget,usageOf}=require('../lib/ai-budget.cjs');
const protectedOptions={protect:async bytes=>Buffer.from('protected:'+bytes.toString('base64')),unprotect:async bytes=>Buffer.from(bytes.toString().slice(10),'base64')};

async function fixture(t,{reply,now}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-ai-budget-test-'));
  const vault=createCredentialStore(directory,protectedOptions),calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json(reply?reply(url):{choices:[{message:{content:'ok'}}],usage:{prompt_tokens:1_000_000,completion_tokens:500_000}});};
  const ai=createAi(directory,fetchImpl,{credentials:vault,...(now?{now}:{})});
  t.after(async()=>{await ai.close();await vault.close();await fs.rm(directory,{recursive:true,force:true});});
  await ai.save({provider:'openai',model:'gpt-4.1-mini',embeddingModel:'off',apiKey:'sk-TEST'});
  return {ai,calls,directory};
}

test('sem limite ativo a IA continua funcionando e o gasto é contabilizado com o preço sugerido',async t=>{
  const f=await fixture(t);
  assert.equal(await f.ai.complete({system:'s',user:'u'}),'ok');
  const view=await f.ai.budget();
  // 1M de entrada × US$ 0,40 + 0,5M de saída × US$ 1,60 = US$ 1,20; em reais com cotação 5,5 = R$ 6,60.
  assert.equal(view.spentUsd,1.2);assert.equal(view.spent,6.6);assert.equal(view.calls,1);assert.equal(view.enabled,false);
  assert.deepEqual(view.model.price,{input:.4,output:1.6});
});

test('bloqueia a chamada quando o gasto do mês passaria do limite, sem falar com o provedor',async t=>{
  const f=await fixture(t);
  await f.ai.saveBudget({enabled:true,limit:1.2,currency:'USD'});
  // A primeira cabe pela estimativa; o provedor informa uso de US$ 1,20 e esgota o limite.
  await f.ai.complete({system:'s',user:'u',maxTokens:100});
  assert.equal(f.calls.length,1);
  await assert.rejects(f.ai.complete({system:'s',user:'u',maxTokens:100}),error=>error.status===402 && /Limite de gastos/.test(error.message));
  assert.equal(f.calls.length,1);
  const view=await f.ai.budget();assert.equal(view.blocked,1);assert.equal(view.spentUsd,1.2);
});

test('limite em reais usa a cotação informada e zerar o contador libera a IA',async t=>{
  const f=await fixture(t);
  await f.ai.saveBudget({enabled:true,limit:6,currency:'BRL',rate:5});
  await f.ai.complete({system:'s',user:'u'});
  let view=await f.ai.budget();assert.equal(view.spent,6);assert.equal(view.reached,true);assert.equal(view.remaining,0);
  await assert.rejects(f.ai.complete({system:'s',user:'u'}),error=>error.status===402);
  view=await f.ai.resetBudget();assert.equal(view.spent,0);
  assert.equal(await f.ai.complete({system:'s',user:'u'}),'ok');
});

test('modelo sem preço conhecido é bloqueado com limite ativo até o preço ser informado',async t=>{
  const f=await fixture(t);
  await f.ai.save({provider:'openai',model:'modelo-novo'});
  await f.ai.saveBudget({enabled:true,limit:10,currency:'USD'});
  await assert.rejects(f.ai.complete({system:'s',user:'u'}),error=>error.status===402 && /preço do modelo modelo-novo/.test(error.message));
  assert.equal(f.calls.length,0);
  const view=await f.ai.saveBudget({prices:{'openai:modelo-novo':{input:1,output:2}}});
  assert.deepEqual(view.model,{key:'openai:modelo-novo',price:{input:1,output:2},custom:true});
  await f.ai.complete({system:'s',user:'u',maxTokens:10});
  assert.equal((await f.ai.budget()).spentUsd,2);
});

test('o contador recomeça a cada mês',async t=>{
  let clock=new Date(2026,10,30,12).getTime();const f=await fixture(t,{now:()=>clock});
  await f.ai.complete({system:'s',user:'u'});assert.equal((await f.ai.budget()).period,'2026-11');
  clock=new Date(2026,11,1,9).getTime();
  const view=await f.ai.budget();assert.equal(view.period,'2026-12');assert.equal(view.spentUsd,0);
});

test('IA local não tem custo nem é bloqueada',async t=>{
  const f=await fixture(t,{reply:()=>({message:{content:'local'},prompt_eval_count:10,eval_count:5})});
  await f.ai.save({provider:'ollama',model:'qwen3:8b'});
  await f.ai.saveBudget({enabled:true,limit:.01,currency:'USD'});
  assert.equal(await f.ai.complete({system:'s',user:'u'}),'local');
  const view=await f.ai.budget();assert.equal(view.free,true);assert.equal(view.spentUsd,0);
});

test('validação do limite e leitura de uso dos provedores',()=>{
  assert.throws(()=>normalizeBudget({enabled:true,limit:0}),/maior que zero/);
  assert.throws(()=>normalizeBudget({currency:'EUR'}),/BRL/);
  assert.throws(()=>normalizeBudget({limit:-1}),/limite/);
  assert.throws(()=>normalizeBudget({prices:{'x y':{input:1}}}),/Modelo inválido/);
  assert.deepEqual(usageOf('anthropic',{usage:{input_tokens:10,output_tokens:3,cache_read_input_tokens:2}}),{input:12,output:3});
  assert.deepEqual(usageOf('gemini',{usageMetadata:{promptTokenCount:7,candidatesTokenCount:2,thoughtsTokenCount:4}}),{input:7,output:6});
  assert.equal(usageOf('openai',{}),null);
});
