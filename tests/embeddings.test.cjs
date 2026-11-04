const {test}=require('node:test');
const {createBlobStore}=require('../lib/database.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createEmbeddingIndex,fuse}=require('../lib/embeddings.cjs');
const {createAi}=require('../lib/ai.cjs');
const {createWhatsAppServer}=require('../server.cjs');
const knowledge=require('../lib/knowledge.cjs');

// Embedding simulado: textos do mesmo assunto apontam para a mesma direção, mesmo sem palavras em comum.
const CONCEPTS=[/voo|voar|passagem|aére|aviao/i,/importa|china|exterior/i,/garantia|troca/i];
const vector=text=>[...CONCEPTS.map(pattern=>pattern.test(text)?1:0),.01];
const DOCS=[{id:'a',name:'passagens.md',text:'Emitimos passagem aérea com milhas para qualquer destino.'},{id:'b',name:'importacao.md',text:'Trazemos mercadorias da China com desembaraço.'},{id:'c',name:'garantia.md',text:'A garantia cobre defeitos por 12 meses.'}];

const temp=async t=>{const folder=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-embed-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));return folder;};
function fakeAi(overrides={}) {
  const calls=[];
  return {calls,embedding:async()=>({model:'modelo',signature:'modelo-1'}),embed:async(texts,options={})=>{calls.push({texts,task:options.task || 'document'});return {vectors:texts.map(vector),signature:'modelo-1'};},...overrides};
}
const index=(ai,directory,docs=DOCS,extra={})=>createEmbeddingIndex({ai,directory,loadTexts:async()=>docs,...extra});

test('busca híbrida encontra por significado o que o BM25 não alcança',async t=>{
  const service=index(fakeAi(),await temp(t));await service.refresh();
  assert.deepEqual(knowledge.search(DOCS,'quero voar'),[]);
  const [first]=await service.search('quero voar');
  assert.equal(first.docName,'passagens.md');assert.deepEqual(first.via,['semantic']);
  assert.deepEqual((await service.status()),{mode:'hybrid',model:'modelo',indexed:3,total:3,indexing:false,error:''});
});

test('pergunta sem relação com a base continua sem trechos',async t=>{
  const service=index(fakeAi(),await temp(t));await service.refresh();
  assert.deepEqual(await service.search('astronomia quântica'),[]);
});

test('o corte do modelo descarta trechos com similaridade abaixo dele',async t=>{
  const ai=fakeAi({embedding:async()=>({model:'modelo',signature:'modelo-1',minSimilarity:.99})}),service=index(ai,await temp(t));await service.refresh();
  ai.embed=async texts=>({vectors:texts.map(()=>[1,.5,0,.01]),signature:'modelo-1'});
  assert.deepEqual(await service.search('quero voar'),[]);
});

test('um trecho achado pelas duas buscas sobe na fusão de rankings',()=>{
  const part=(docId,index)=>({docId,docName:docId,index,text:docId});
  const merged=fuse([part('a',0),part('b',0)],[part('b',0),part('c',0)],3);
  assert.equal(merged[0].docId,'b');assert.deepEqual(merged[0].via,['lexical','semantic']);assert.equal(merged[0].relevance,1);
  assert.deepEqual(new Set(merged.map(item=>item.docId)),new Set(['a','b','c']));
});

test('o índice sobrevive ao reinício e só refaz o documento alterado',async t=>{
  const directory=await temp(t),docs=DOCS.map(doc=>({...doc})),first=fakeAi();
  await index(first,directory,docs).refresh();
  assert.equal(first.calls.length,3);
  const second=fakeAi(),service=index(second,directory,docs);await service.refresh();
  assert.equal(second.calls.length,0);
  docs[2].text='A troca pode ser feita em 7 dias.';await service.refresh();
  assert.equal(second.calls.length,1);assert.match(second.calls[0].texts[0],/troca/);
  assert.equal((await service.search('garantia')).length>0,true);
});

test('trocar de modelo refaz os vetores e documento excluído perde os vetores',async t=>{
  const directory=await temp(t),docs=[...DOCS];await index(fakeAi(),directory,docs).refresh();
  const other=fakeAi({embedding:async()=>({model:'novo',signature:'modelo-2'}),embed:async texts=>{other.calls.push(texts);return {vectors:texts.map(vector),signature:'modelo-2'};}}),service=index(other,directory,docs);
  await service.refresh();assert.equal(other.calls.length,3);
  docs.pop();await service.refresh();
  assert.deepEqual((await createBlobStore(directory,'embeddings').keys()).sort(),['a','b']);
});

test('falha do provedor mantém o BM25, informa o erro e aguarda antes de tentar de novo',async t=>{
  let clock=1000,calls=0;
  const service=index(fakeAi({embed:async()=>{calls++;throw new Error('modelo ausente');}}),await temp(t),DOCS,{now:()=>clock});
  await service.refresh();
  const results=await service.search('garantia');
  assert.equal(results[0].docName,'garantia.md');assert.equal(calls,1);
  assert.deepEqual(await service.status(),{mode:'lexical',model:'modelo',indexed:0,total:3,indexing:false,error:'modelo ausente'});
  clock+=5*60_000;await service.refresh();assert.equal(calls,2);
});

test('pergunta falha depois de indexar: cai no BM25 sem repetir a chamada a cada mensagem',async t=>{
  let broken=false,queries=0;const ai=fakeAi(),embed=ai.embed;
  ai.embed=async(texts,options)=>{if(options?.task==='query') {queries++;if(broken) throw new Error('fora do ar');}return embed(texts,options);};
  const service=index(ai,await temp(t));await service.refresh();broken=true;
  assert.equal((await service.search('garantia'))[0].docName,'garantia.md');
  assert.equal((await service.search('garantia'))[0].docName,'garantia.md');
  assert.equal(queries,1);
});

test('sem modelo de embeddings a busca é só BM25 e não chama o provedor',async t=>{
  const ai=fakeAi({embedding:async()=>null}),service=index(ai,await temp(t));await service.refresh();
  assert.equal((await service.search('garantia'))[0].relevance,1);assert.equal(ai.calls.length,0);
  assert.equal((await service.status()).mode,'lexical');
});

test('plural em -ns e -ões encontra o singular',()=>{
  assert.deepEqual(knowledge.tokenize('passagens opções produtos'),['passagem','opcao','produto']);
  assert.equal(knowledge.search(DOCS,'passagens')[0].docName,'passagens.md');
});

const credentials=()=>{const keys=new Map();return {has:async name=>keys.has(name),get:async name=>keys.get(name)||null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);},close:async()=>{}};};
const reply=body=>async()=>({ok:true,status:200,text:async()=>JSON.stringify(body)});

test('adaptadores enviam o formato de cada provedor e nunca entregam a chave ao Ollama',async t=>{
  const requests=[],responses={openai:{data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]},gemini:{embeddings:[{values:[1,0]},{values:[0,1]}]},ollama:{embeddings:[[1,0],[0,1]]}};
  let body;const fetchImpl=async(url,options)=>{requests.push({url,headers:options.headers,body:JSON.parse(options.body)});return reply(body)();};
  const ai=createAi(await temp(t),fetchImpl,{credentials:credentials()});t.after(()=>ai.close());
  await ai.save({provider:'openai',model:'m',apiKey:'chave-secreta'});body=responses.openai;
  assert.deepEqual((await ai.embed(['a','b'])).vectors,[[1,0],[0,1]],'A OpenAI pode responder fora de ordem.');
  assert.equal(requests.at(-1).url,'https://api.openai.com/v1/embeddings');assert.equal(requests.at(-1).body.model,'text-embedding-3-small');
  await ai.save({provider:'gemini',model:'m',apiKey:'chave-secreta'});body=responses.gemini;
  await ai.embed(['a','b'],{task:'query'});
  assert.match(requests.at(-1).url,/gemini-embedding-001:batchEmbedContents$/);assert.equal(requests.at(-1).body.requests[0].taskType,'RETRIEVAL_QUERY');
  await ai.save({provider:'anthropic',model:'m',apiKey:'chave-secreta'});body=responses.ollama;
  const result=await ai.embed(['a','b']);
  assert.equal(requests.at(-1).url,'http://127.0.0.1:11434/api/embed');assert.equal(requests.at(-1).body.model,'bge-m3');assert.equal((await ai.embedding()).minSimilarity,.45);
  assert.equal(JSON.stringify(requests.at(-1)).includes('chave-secreta'),false);assert.match(result.signature,/^ollama\|/);
  await ai.save({provider:'openai',model:'m',embeddingModel:'off'});
  assert.equal(await ai.embedding(),null);await assert.rejects(ai.embed(['a']),/embeddings/);
  body={data:[{index:0,embedding:[1,'x']}]};await ai.save({provider:'openai',model:'m',embeddingModel:'outro'});
  await assert.rejects(ai.embed(['a']),/inválida/);
});

test('HTTP: documento novo é indexado e a pergunta usa o trecho achado por significado',async t=>{
  const directory=await temp(t),prompts=[];
  const aiFetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.endsWith('/embeddings')) return reply({data:body.input.map((text,index)=>({index,embedding:vector(text)}))})();
    prompts.push(body.messages[0].content);return reply({choices:[{message:{content:'Sim, emitimos passagens.'}}]})();
  };
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'teste'},storeDir:directory,aiFetch,credentials:credentials()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await server.cleanup;});
  const base=`http://127.0.0.1:${server.address().port}`,token=(await (await fetch(base)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];
  const api=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token,Origin:base},...(input?{body:JSON.stringify(input)}:{})}),body=await response.json();assert.equal(response.ok,true,JSON.stringify(body));return body;};
  await api('/api/ai','PUT',{provider:'openai',model:'m',apiKey:'k'});
  await api('/api/kb','POST',{name:'passagens.md',text:DOCS[0].text});
  let status;for(let attempt=0;attempt<50;attempt++) {status=(await api('/api/kb')).search;if(status.indexed===1 && !status.indexing) break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(status.mode,'hybrid');assert.equal(status.model,'text-embedding-3-small');
  const asked=await api('/api/kb/ask','POST',{question:'quero voar'});
  assert.equal(asked.usedAi,true);assert.deepEqual(asked.sources[0].via,['semantic']);
  assert.match(prompts[0],/<contexto>[\s\S]*passagem aérea[\s\S]*<\/contexto>/);
});
