// Avaliação da RECUPERAÇÃO (sem geração). Compara o que o app faz (híbrido + níveis de confiabilidade)
// com duas ablações: só palavras-chave (BM25 do app) e só embeddings (mesmo modelo, sem corte).
// Saída: results/retrieval.json
const fs=require('node:fs');
const path=require('node:path');
const {knowledge,snapshot,createInstance,score,semanticIndex,percentile}=require('./harness.cjs');
const data=require('./dataset.cjs');

const queryOf=test=>{if(test.mode!=='chat') return test.q;const pending=[];for(let index=test.history.length-1;index>=0 && test.history[index].from==='cliente';index--) pending.unshift(test.history[index].text);return pending.join('\n');};
const goldOf=test=>test.gold || (test.docOnly?[[{doc:test.docOnly,must:''}]]:null);
const brief=list=>list.map(item=>({doc:item.docName,index:item.index,confidence:item.confidence,via:item.via,similarity:item.similarity===undefined?undefined:Number(item.similarity.toFixed(3))}));

async function evaluate(instance,tests,label) {
  const semantic=await semanticIndex(instance),docs=await instance.services.loadTexts(),rows=[],latency=[];
  for(const test of tests) {
    const query=queryOf(test),gold=goldOf(test),row={id:test.id,split:test.split,cat:test.cat,corpus:label,query};
    let started=Date.now();const raw=await instance.services.embeddings.search(query,{limit:10});latency.push(Date.now()-started);row.ms=latency.at(-1);
    const levels={};for(const level of ['strict','balanced','flexible']) levels[level]=await instance.services.embeddings.search(query,{reliability:level});
    const lexical=knowledge.search(docs,query,10),vectors=(await semantic(query)).slice(0,10);
    row.results={hybrid:brief(raw),balanced:brief(levels.balanced),strict:brief(levels.strict),flexible:brief(levels.flexible),bm25:brief(lexical),semantic:brief(vectors)};
    if(gold) {
      row.metrics={};
      for(const [name,list] of [['hybrid',raw],['bm25',lexical],['semantic',vectors]]) row.metrics[name]={r1:score(list,gold,1).all,r4:score(list,gold,4).all,r10:score(list,gold,10).all,rr:score(list,gold,10).rr,partial4:score(list,gold,4).recall};
      for(const level of ['strict','balanced','flexible']) row.metrics[level]={sent:levels[level].length,all:score(levels[level],gold,levels[level].length || 1).all,rr:score(levels[level],gold,10).rr,top:levels[level][0]?.confidence || 'nenhuma',topRelevant:score(levels[level],gold,1).rr===1};
    } else row.sent={strict:levels.strict.length,balanced:levels.balanced.length,flexible:levels.flexible.length,raw:raw.length,top:raw[0]?.confidence || 'nenhuma',topSimilarity:vectors[0]?.similarity};
    rows.push(row);
    process.stdout.write(`${test.id} ${gold?(row.metrics.balanced.all?'ok ':'FALHA')+' rr='+row.metrics.hybrid.rr.toFixed(2)+' enviados='+row.metrics.balanced.sent:'sem-gold enviados='+row.sent.balanced} ${row.ms}ms | ${query.replace(/\n/g,' / ').slice(0,60)}\n`);
  }
  return {rows,latency:{n:latency.length,p50:percentile(latency,50),p95:percentile(latency,95),max:Math.max(...latency)}};
}

(async()=>{
  const prod=snapshot(),output={startedAt:new Date().toISOString(),app:require('./harness.cjs').APP_ROOT,config:{ai:prod.ai,productionReliability:prod.reliability}};
  const realInstance=await createInstance({documents:prod.documents,products:prod.products,ai:prod.ai});
  output.real={indexMs:realInstance.indexMs,chunks:(await realInstance.chunks()).length,...await evaluate(realInstance,[...data.real,...data.dev],'real')};
  await realInstance.close();
  const syntheticDocs=data.synthetic.documents.map(doc=>doc.csv?{name:doc.name,base64:Buffer.from(doc.csv).toString('base64')}:{name:doc.name,text:doc.text});
  const mixed=await createInstance({documents:[...prod.documents,...syntheticDocs],products:prod.products,ai:prod.ai});
  // As perguntas reais rodam de novo com os documentos sintéticos como distratores.
  output.synthetic={indexMs:mixed.indexMs,chunks:(await mixed.chunks()).length,...await evaluate(mixed,[...data.synthetic.tests,...data.real.map(test=>({...test,id:test.id+'+d'}))],'synt')};
  await mixed.close();
  fs.mkdirSync(path.join(__dirname,'results'),{recursive:true});fs.writeFileSync(path.join(__dirname,'results','retrieval.json'),JSON.stringify(output,null,1));
  console.log('latência real',JSON.stringify(output.real.latency),'| com sintético',JSON.stringify(output.synthetic.latency));
})().catch(error=>{console.error(error);process.exit(1);});
