const path=require('node:path');
const {createHash}=require('node:crypto');
const knowledge=require('./knowledge.cjs');
const {createBlobStore}=require('./database.cjs');

const BATCH=64,CANDIDATES=20,RRF_K=60,MIN_SIMILARITY=.3,RETRY_MS=5*60_000,QUERY_TIMEOUT_MS=15_000,QUERY_CHARS=2000;
const sha=value=>createHash('sha256').update(value).digest('hex');

// Vetores unitários em uma matriz contínua: a similaridade de cosseno vira um produto escalar.
function pack(vectors) {
  const size=vectors[0].length,matrix=new Float32Array(vectors.length*size);
  vectors.forEach((vector,row)=>{const length=Math.hypot(...vector) || 1;vector.forEach((value,column)=>{matrix[row*size+column]=value/length;});});
  return {size,matrix};
}

// Reciprocal Rank Fusion: combina as duas listas pela posição, pois as notas de BM25 e cosseno não são comparáveis.
function fuse(lexical,semantic,limit) {
  const merged=new Map();
  for(const [via,list] of [['lexical',lexical],['semantic',semantic]]) list.forEach((part,rank)=>{
    const key=part.docId+':'+part.index,entry=merged.get(key) || {docId:part.docId,docName:part.docName,index:part.index,text:part.text,score:0,via:[]};
    entry.score+=1/(RRF_K+rank+1);entry.via.push(via);merged.set(key,entry);
  });
  const ranked=[...merged.values()].sort((a,b)=>b.score-a.score).slice(0,limit),top=ranked[0]?.score || 1;
  return ranked.map(part=>({...part,relevance:Number((part.score/top).toFixed(2))}));
}

// Índice vetorial por documento. Se o provedor falhar ou não oferecer embeddings, a busca continua só com BM25.
function createEmbeddingIndex({ai,loadTexts,directory,now=Date.now}) {
  // Vetores ficam no data/central.sqlite (um item por documento); a pasta antiga embeddings/ é importada uma vez.
  const vectorsStore=createBlobStore(directory,'embeddings',{legacyDir:path.join(directory,'embeddings'),keyOf:name=>name.endsWith('.json')?name.slice(0,-5):null}),cache=new Map(),controller=new AbortController();
  let running=null,pending=false,stopped=false,retryAt=0,lastError='';
  const fail=error=>{if(stopped) return;lastError=error.message;retryAt=now()+RETRY_MS;};

  async function entry(doc,signature) {
    const hash=sha(doc.text);let item=cache.get(doc.id);
    if(!item) {
      try {
        const saved=JSON.parse(await vectorsStore.getText(doc.id)),buffer=Buffer.from(saved.vectors,'base64');
        item={signature:saved.signature,hash:saved.hash,size:saved.size,matrix:new Float32Array(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.length))};
        cache.set(doc.id,item);
      } catch {return null;}
    }
    return item.signature===signature && item.hash===hash?item:null;
  }
  async function save(doc,signature,vectors) {
    const {size,matrix}=pack(vectors),hash=sha(doc.text);
    await vectorsStore.put(doc.id,JSON.stringify({signature,hash,size,vectors:Buffer.from(matrix.buffer).toString('base64')}));
    cache.set(doc.id,{signature,hash,size,matrix});
  }
  async function build() {
    const docs=(await loadTexts()).filter(doc=>doc.text),ids=new Set(docs.map(doc=>doc.id));
    for(const id of await vectorsStore.keys()) if(!ids.has(id)) {cache.delete(id);await vectorsStore.remove(id);}
    const target=await ai.embedding();if(!target) return;
    for(const doc of docs) {
      if(stopped) return;
      if(await entry(doc,target.signature)) continue;
      const chunks=knowledge.chunkText(doc.text),vectors=[];
      for(let index=0;index<chunks.length;index+=BATCH) {
        const result=await ai.embed(chunks.slice(index,index+BATCH),{signal:controller.signal});
        // O provedor mudou no meio do caminho: recomeça para não misturar vetores de modelos diferentes.
        if(result.signature!==target.signature) {pending=true;return;}
        vectors.push(...result.vectors);
      }
      if(stopped) return;
      await save(doc,target.signature,vectors);
    }
    lastError='';
  }
  function refresh({force=false}={}) {
    if(force) retryAt=0;
    if(stopped || now()<retryAt) return running;
    if(running) {pending=true;return running;}
    running=build().catch(fail).finally(()=>{running=null;if(pending) {pending=false;refresh();}});
    return running;
  }
  async function nearest(docs,query) {
    const target=await ai.embedding();if(!target || now()<retryAt) return [];
    const available=docs.filter(doc=>doc.text),pairs=await Promise.all(available.map(async doc=>[doc,await entry(doc,target.signature)])),ready=pairs.filter(([,item])=>item);
    if(ready.length<available.length) refresh();
    if(!ready.length) return [];
    const result=await ai.embed([query.slice(-QUERY_CHARS)],{task:'query',timeoutMs:QUERY_TIMEOUT_MS,signal:controller.signal}),{size,matrix:wanted}=pack(result.vectors);
    lastError='';const parts=[];
    for(const [doc,item] of ready) {
      if(item.size!==size || item.signature!==result.signature) continue;
      knowledge.chunkText(doc.text).forEach((text,index)=>{
        let similarity=0;for(let column=0;column<size;column++) similarity+=wanted[column]*item.matrix[index*size+column];
        if(similarity>=(target.minSimilarity ?? MIN_SIMILARITY)) parts.push({docId:doc.id,docName:doc.name,index,text,similarity});
      });
    }
    return parts.sort((a,b)=>b.similarity-a.similarity).slice(0,CANDIDATES);
  }
  return {
    refresh,
    async search(query,limit=5) {
      const docs=await loadTexts(),lexical=knowledge.search(docs,query,CANDIDATES);
      const semantic=await nearest(docs,query).catch(error=>{fail(error);return [];});
      return semantic.length?fuse(lexical,semantic,limit):lexical.slice(0,limit);
    },
    async status() {
      const docs=(await loadTexts()).filter(doc=>doc.text),target=await ai.embedding();let indexed=0;
      if(target) for(const doc of docs) if(await entry(doc,target.signature)) indexed++;
      return {mode:indexed && now()>=retryAt?'hybrid':'lexical',model:target?.model || null,indexed,total:docs.length,indexing:Boolean(running),error:target?lastError:''};
    },
    async idle() {while(running) await running;},
    async close() {stopped=true;controller.abort();await running;}
  };
}
module.exports={createEmbeddingIndex,fuse,MIN_SIMILARITY};
