const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createLocalAi}=require('../lib/local-ai.cjs');
function fixture({running=false,installed=true,models=['qwen2.5:7b'],loadError=false}={}) {
  let online=running,loaded=false,cpu=false,launches=0,loads=0;const requests=[];
  const service=createLocalAi({findExecutable:async()=>installed?'C:/Ollama/ollama.exe':null,launch:async()=>{launches++;online=true;},delay:async()=>{},fetchImpl:async(url,options={})=>{
    requests.push({url:String(url),options});if(!online) throw Error('ECONNREFUSED');const route=new URL(url).pathname;
    if(route==='/api/version') return Response.json({version:'test'});
    if(route==='/api/tags') return Response.json({models:models.map(name=>({name,model:name}))});
    if(route==='/api/ps') return Response.json({models:loaded?[{name:'qwen2.5:7b',size_vram:cpu?0:1000}]:[]});
    if(route==='/api/generate') {loads++;if(loadError) return Response.json({error:'PRIVATE INTERNAL ERROR'},{status:500});loaded=true;cpu=JSON.parse(options.body).options.num_gpu===0;return Response.json({model:'qwen2.5:7b',done:true});}
    throw Error('Unexpected route');
  }});
  return {service,requests,launches:()=>launches,loads:()=>loads};
}
test('local status reports installation and offline service without launching anything',async()=>{
  const f=fixture();const status=await f.service.status({model:'qwen2.5:7b'});assert.equal(status.installed,true);assert.equal(status.running,false);assert.equal(f.launches(),0);assert.equal(f.loads(),0);
});
test('start launches hidden local runtime and preloads installed model without a prompt',async()=>{
  const f=fixture();const result=await f.service.start({model:'qwen2.5:7b'});assert.equal(result.loaded,true);assert.equal(f.launches(),1);assert.equal(f.loads(),1);
  const body=JSON.parse(f.requests.find(item=>item.url.endsWith('/api/generate')).options.body);assert.equal(body.model,'qwen2.5:7b');assert.equal(body.stream,false);assert.equal(body.prompt,undefined);assert.equal(body.keep_alive,'30m');assert.equal(body.options.num_ctx,8192);
});
test('start reuses already running runtime and deduplicates concurrent clicks',async()=>{
  const f=fixture({running:true});const results=await Promise.all([f.service.start({model:'qwen2.5:7b'}),f.service.start({model:'qwen2.5:7b'})]);assert.equal(results.every(result=>result.loaded),true);assert.equal(f.launches(),0);assert.equal(f.loads(),1);await f.service.start({model:'qwen2.5:7b'});assert.equal(f.loads(),1);
});
test('missing Ollama explains installation without downloading or starting arbitrary commands',async()=>{
  const f=fixture({installed:false});await assert.rejects(f.service.start({model:'qwen2.5:7b'}),error=>error.status===409 && /instal/i.test(error.message));assert.equal(f.launches(),0);assert.equal(f.loads(),0);
});
test('missing model gives explicit error and never triggers a pull',async()=>{
  const f=fixture({running:true,models:[]});await assert.rejects(f.service.start({model:'qwen2.5:7b'}),error=>error.status===409 && /modelo/i.test(error.message));assert.equal(f.requests.some(item=>item.url.includes('/pull')),false);assert.equal(f.loads(),0);
});
test('local launcher rejects remote endpoints and invalid model arguments before making requests',async()=>{
  const f=fixture();for(const input of [null,{model:123},{model:''},{model:'x',baseUrl:'http://example.com'},{model:'x',baseUrl:'http://127.0.0.1:9999'},{model:'x',baseUrl:'http://user:pass@localhost:11434'},{model:'x; calc.exe'},{model:'model-cloud'}]) await assert.rejects(f.service.start(input),error=>error.status===422);
  assert.equal(f.requests.length,0);assert.equal(f.launches(),0);
});
test('model loading error is sanitized and an explicit retry can succeed later',async()=>{
  const f=fixture({running:true,loadError:true});await assert.rejects(f.service.start({model:'qwen2.5:7b'}),error=>error.status===502 && !error.message.includes('PRIVATE'));await assert.rejects(f.service.start({model:'qwen2.5:7b'}));assert.equal(f.loads(),2);
});
test('explicit CPU option uses no GPU and returns actual execution mode',async()=>{
  const f=fixture({running:true});const state=await f.service.start({model:'qwen2.5:7b',device:'cpu'});assert.equal(state.loaded,true);assert.equal(state.executionMode,'cpu');assert.equal(JSON.parse(f.requests.find(item=>item.url.endsWith('/api/generate')).options.body).options.num_gpu,0);
});
