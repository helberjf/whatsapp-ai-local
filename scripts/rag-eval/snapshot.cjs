// Copia, só com leituras (GET), a base de conhecimento, o catálogo e as regras da central em uso.
// Nada é gravado na central. Saída: corpus/prod-snapshot.json (dados do negócio; não publicar).
const fs=require('node:fs');
const path=require('node:path');
const BASE=process.env.CENTRAL_URL || 'http://127.0.0.1:8766';
(async()=>{
  const page=await (await fetch(BASE)).text(),token=page.match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];
  const get=async route=>{const response=await fetch(BASE+route,{headers:{'X-WhatsApp-Token':token}});if(!response.ok) throw new Error(route+' '+response.status);return response.json();};
  const kb=await get('/api/kb'),documents=[];
  for(const doc of kb.documents) {const full=await get('/api/kb/doc?id='+doc.id);if(full.truncated) throw new Error('documento truncado: '+doc.name);documents.push({name:doc.name,source:doc.source,chars:doc.chars,chunks:doc.chunks,text:full.text});}
  const products=(await get('/api/products')).products.map(({name,kind,category,sku,price,discountPercent,stock,description,warranty,active})=>({name,kind,category,sku,price,discountPercent,stock,description,warranty,active}));
  const assistant=await get('/api/assistant'),ai=await get('/api/ai'),health=await get('/api/ai/health');
  const snapshot={takenAt:new Date().toISOString(),build:(await (await fetch(BASE+'/health')).json()).build,search:kb.search,reliability:kb.reliability,
    ai:{provider:ai.provider,model:ai.model,embeddingModel:ai.embeddingModel,ollamaNumGpu:ai.ollamaNumGpu,baseUrl:ai.baseUrl},
    assistant:{enabled:assistant.enabled,audience:assistant.audience,source:assistant.source,history:assistant.history,tone:assistant.tone,rules:assistant.rules},health:{watching:health.watching,running:health.running},documents,products};
  const file=path.join(__dirname,'corpus','prod-snapshot.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(snapshot,null,2));
  console.log('documentos',documents.map(doc=>doc.name+':'+doc.chars).join(' '),'| produtos',products.length,'| regras',assistant.rules.length,'| assistente',JSON.stringify({source:assistant.source,tone:assistant.tone,history:assistant.history}));
})().catch(error=>{console.error(error.message);process.exit(1);});
