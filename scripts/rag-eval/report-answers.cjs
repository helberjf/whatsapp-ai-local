// Resume results/answers-<corpus>.json. Aplica a revisão manual (review.json) por cima da correção automática
// e mostra as duas. Uso: node report-answers.cjs real|synt [--full]
const fs=require('node:fs');
const path=require('node:path');
const {percentile}=require('./harness.cjs');
const data=require('./dataset.cjs');
const corpus=process.argv[2]==='synt'?'synt':'real',full=process.argv.includes('--full');
const output=JSON.parse(fs.readFileSync(path.join(__dirname,'results',`answers-${corpus}${process.env.RUN_TAG || ''}.json`),'utf8'));
const reviewFile=path.join(__dirname,`review${process.env.RUN_TAG || ''}.json`),review=fs.existsSync(reviewFile)?JSON.parse(fs.readFileSync(reviewFile,'utf8')):{};
const tests=new Map((corpus==='real'?data.real:data.synthetic.tests).map(test=>[test.id,test]));
const pct=(n,d)=>d?`${n}/${d} (${Math.round(100*n/d)}%)`:'—';
// Resultado principal = última execução de cada pergunta. A 1ª execução das perguntas repetidas aconteceu durante
// a queda de 5 minutos da busca semântica e é relatada à parte (--incident).
const lastRound=id=>Math.max(...output.runs.filter(run=>run.id===id).map(run=>run.round));
const incident=process.argv.includes('--incident');
const runs=output.runs.filter(run=>incident?run.round===0 && lastRound(run.id)>0:run.round===lastRound(run.id)).map(run=>{const manual=review[run.id];const test=tests.get(run.id);run.question ||= test.q || test.history.map(m=>m.from+": "+m.text).join(" | ");return {...run,test,final:manual?manual.pass:run.auto.pass,note:manual?.note};});
console.log(`config: ${JSON.stringify(output.config)} | catálogo ${output.catalogChars} caracteres | ${runs.length} casos`);
console.log('\ncategoria            automático     após revisão manual   encaminhou   gabarito no contexto');
for(const cat of [...new Set(runs.map(run=>run.cat))]) {
  const list=runs.filter(run=>run.cat===cat),withGold=list.filter(run=>run.goldSent!==undefined);
  console.log(cat.padEnd(20),pct(list.filter(run=>run.auto.pass).length,list.length).padEnd(14),pct(list.filter(run=>run.final).length,list.length).padEnd(21),String(list.filter(run=>run.handoff).length).padEnd(12),withGold.length?pct(withGold.filter(run=>run.goldSent).length,withGold.length):'—');
}
const answerable=runs.filter(run=>!run.test.abstain),abstain=runs.filter(run=>run.test.abstain);
console.log('\nrespondíveis corretas:',pct(answerable.filter(run=>run.final).length,answerable.length),'| encaminhadas sem necessidade:',pct(answerable.filter(run=>run.handoff).length,answerable.length));
console.log('abstenção correta:',pct(abstain.filter(run=>run.final).length,abstain.length));
const numbers=runs.filter(run=>run.unsupported?.length);
console.log('respostas com número ou valor fora do contexto:',pct(numbers.length,runs.length),numbers.map(run=>run.id+':'+run.unsupported.join(',')).join(' | '));
const ok=answerable.filter(run=>run.goldSent!==undefined);
console.log('com o trecho certo no contexto → correta:',pct(ok.filter(run=>run.goldSent && run.final).length,ok.filter(run=>run.goldSent).length),'| sem o trecho certo → correta:',pct(ok.filter(run=>!run.goldSent && run.final).length,ok.filter(run=>!run.goldSent).length));
const ms=runs.map(run=>run.ms).filter(Boolean);
console.log('latência ponta a ponta (s): p50',(percentile(ms,50)/1000).toFixed(1),'p95',(percentile(ms,95)/1000).toFixed(1),'máx',(Math.max(...ms)/1000).toFixed(1),'| erros',runs.filter(run=>run.error).length);
if(output.runs.some(run=>run.round>0)) {
  const ids=[...new Set(output.runs.filter(run=>run.round>0).map(run=>run.id))],unstable=ids.filter(id=>new Set(output.runs.filter(run=>run.id===id).map(run=>run.auto.pass)).size>1);
  console.log('repetições:',ids.length,'casos repetidos | resultado automático mudou em',unstable.length,unstable.join(' '));
}
console.log('\n--- falhas após revisão ---');
for(const run of runs.filter(run=>!run.final)) console.log(`${run.id} [${run.cat}] ${run.question.slice(0,110)}\n   resposta: ${String(run.answer || run.error).replace(/\s+/g,' ').slice(0,330)}\n   motivo: ${run.note || run.auto.reasons.join('; ')} | fontes: ${run.sources?.map(item=>item.doc.slice(0,14)+':'+item.confidence).join(' ') || '(nenhuma)'}`);
if(full) {console.log('\n--- todas as respostas ---');for(const run of runs) console.log(`\n${run.id} [${run.cat}] auto=${run.auto.pass?'ok':'FALHA'}${review[run.id]?' manual='+(run.final?'ok':'FALHA'):''} ${(run.ms/1000).toFixed(0)}s gold=${run.goldSent} ${run.handoff?'[encaminhou]':''}\n P: ${run.question}\n E: ${run.test.expect}\n R: ${String(run.answer || run.error).replace(/\s+/g,' ')}\n ${run.auto.pass?'':'auto: '+run.auto.reasons.join('; ')}${run.unsupported?.length?' | números fora do contexto: '+run.unsupported.join(','):''}${run.retrievalQuery?' | consulta da busca: '+JSON.stringify(run.retrievalQuery):''}`);}
