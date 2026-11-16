// Confere o gabarito sem IA: cada alternativa de gold precisa existir em algum trecho gerado pelo chunking real.
const {knowledge,snapshot,hit}=require('./harness.cjs');
const data=require('./dataset.cjs');
const chunksOf=documents=>documents.flatMap(doc=>knowledge.chunkText(doc.text).map((text,index)=>({docName:doc.name,index,text})));
const syntheticDocs=data.synthetic.documents.map(doc=>({name:doc.name,text:doc.csv?knowledge.extractText(doc.name,Buffer.from(doc.csv)):doc.text}));
const real=chunksOf(snapshot().documents),synthetic=[...real,...chunksOf(syntheticDocs)];
let problems=0;
for(const [tests,chunks] of [[data.real,real],[data.synthetic.tests,synthetic]]) for(const test of tests) for(const group of test.gold || []) for(const alt of group) {
  const found=chunks.filter(chunk=>hit(chunk,alt));
  if(!found.length) {problems++;console.log('SEM TRECHO',test.id,JSON.stringify(alt));}
}
const count=list=>Object.entries(list.reduce((total,test)=>({...total,[test.cat]:(total[test.cat] || 0)+1}),{})).map(([cat,n])=>cat+':'+n).join(' ');
console.log('real',data.real.length,'|',count(data.real));
console.log('sintético',data.synthetic.tests.length,'|',count(data.synthetic.tests));
console.log('dev',data.dev.length,'| trechos reais',real.length,'| trechos com sintético',synthetic.length,'| problemas',problems);
if(process.argv.includes('--chunks')) for(const chunk of chunksOf(syntheticDocs)) console.log('\n== '+chunk.docName+' #'+chunk.index+' ('+chunk.text.length+')\n'+chunk.text);
process.exitCode=problems?1:0;
