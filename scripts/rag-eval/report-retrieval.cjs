// Resume results/retrieval.json: métricas por configuração e por categoria, falhas e calibração do rótulo de confiança.
const fs=require('node:fs');
const path=require('node:path');
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'results','retrieval.json'),'utf8'));
const pct=(n,d)=>d?`${n}/${d} (${Math.round(100*n/d)}%)`:'—';
const mean=list=>list.length?(list.reduce((sum,value)=>sum+value,0)/list.length).toFixed(3):'—';
function block(title,rows) {
  const gold=rows.filter(row=>row.metrics);if(!gold.length) return;
  console.log(`\n## ${title} — ${gold.length} perguntas com gabarito de trecho`);
  console.log('config       R@1          R@4          R@10         MRR');
  for(const name of ['hybrid','bm25','semantic']) console.log(name.padEnd(12),pct(gold.filter(row=>row.metrics[name].r1).length,gold.length).padEnd(12),pct(gold.filter(row=>row.metrics[name].r4).length,gold.length).padEnd(12),pct(gold.filter(row=>row.metrics[name].r10).length,gold.length).padEnd(12),mean(gold.map(row=>row.metrics[name].rr)));
  console.log('nível (o que o app envia à IA)   gabarito enviado   média de trechos   nenhum trecho');
  for(const level of ['strict','balanced','flexible']) console.log(level.padEnd(32),pct(gold.filter(row=>row.metrics[level].all).length,gold.length).padEnd(18),mean(gold.map(row=>row.metrics[level].sent)).padEnd(18),gold.filter(row=>!row.metrics[level].sent).length);
  const cats=[...new Set(gold.map(row=>row.cat))];
  console.log('por categoria (equilibrado: gabarito enviado | híbrido R@1):');
  for(const cat of cats) {const list=gold.filter(row=>row.cat===cat);console.log('  '+cat.padEnd(18),pct(list.filter(row=>row.metrics.balanced.all).length,list.length).padEnd(14),pct(list.filter(row=>row.metrics.hybrid.r1).length,list.length));}
  // O rótulo "alta" do primeiro trecho acerta?
  for(const label of ['alta','media','baixa']) {const list=gold.filter(row=>row.results.hybrid[0]?.confidence===label);console.log(`  1º trecho rotulado ${label}: relevante em ${pct(list.filter(row=>row.metrics.hybrid.r1).length,list.length)}`);}
  for(const row of gold.filter(row=>!row.metrics.balanced.all)) console.log(`  FALHA ${row.id} [${row.cat}] "${row.query.replace(/\n/g,' / ').slice(0,70)}" enviados: ${row.results.balanced.map(item=>item.doc.slice(0,2)+'#'+item.index+':'+item.confidence[0]).join(' ') || '(nada)'} | híbrido top5: ${row.results.hybrid.slice(0,5).map(item=>item.doc.slice(0,2)+'#'+item.index+':'+item.confidence[0]+(item.similarity?'/'+item.similarity:'')).join(' ')}`);
}
function abstain(title,rows) {
  const list=rows.filter(row=>row.sent);if(!list.length) return;
  console.log(`\n## ${title} — ${list.length} perguntas sem trecho esperado`);
  for(const level of ['strict','balanced','flexible']) console.log(`  ${level}: nenhum trecho enviado em ${pct(list.filter(row=>!row.sent[level]).length,list.length)}`);
  for(const row of list) console.log(`  ${row.id} [${row.cat}] enviados eq=${row.sent.balanced} rig=${row.sent.strict} 1º=${row.sent.top} sim.máx=${row.sent.topSimilarity?.toFixed(3)} "${row.query.replace(/\n/g,' / ').slice(0,60)}"`);
}
const real=data.real.rows,synt=data.synthetic.rows;
console.log('trechos: real',data.real.chunks,'| com sintético',data.synthetic.chunks,'| indexação real',Math.round(data.real.indexMs/1000)+'s','| mista',Math.round(data.synthetic.indexMs/1000)+'s');
console.log('latência da busca híbrida (ms): real',JSON.stringify(data.real.latency),'| mista',JSON.stringify(data.synthetic.latency));
block('TESTE, base real',real.filter(row=>row.split==='test'));
block('DEV (já usadas na calibração), base real',real.filter(row=>row.split==='dev'));
block('TESTE, perguntas reais com distratores sintéticos',synt.filter(row=>row.id.endsWith('+d')));
block('TESTE, perguntas sintéticas',synt.filter(row=>!row.id.endsWith('+d')));
abstain('TESTE, base real',real.filter(row=>row.split==='test'));
abstain('DEV fora do assunto',real.filter(row=>row.split==='dev'));
