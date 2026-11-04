// Confere a base: mostra, para cada pergunta, o trecho encontrado e a confiança.
// Uso: npm run rag:testar   ou   npm run rag:testar -- --pergunta "Vocês entregam?" --confiabilidade strict
const path=require('node:path');
const rag=require('./rag-lib.cjs');
const LEVELS={strict:'rigorosa',balanced:'equilibrada',flexible:'flexível'};

async function main() {
  const options={...rag.DEFAULTS,...rag.parseArgs(process.argv.slice(2))};
  if(options.confiabilidade && !LEVELS[options.confiabilidade]) throw new Error('Use --confiabilidade strict, balanced ou flexible.');
  const file=options.perguntas || path.join(options.pasta,rag.QUESTIONS_FILE);
  const questions=typeof options.pergunta==='string'?[options.pergunta]:await rag.readQuestions(file);
  if(!questions.length) throw new Error(`Nenhuma pergunta em ${file}. Rode npm run rag:configurar ou use --pergunta "...".`);
  const connection=await rag.connect(options);
  try {
    const status=await connection.status();
    console.log(`Base via ${connection.mode==='app'?'central aberta':'pasta de dados'} · ${status.mode==='hybrid'?'palavras + significado ('+status.model+')':'só palavras-chave'}${options.confiabilidade?' · confiabilidade '+LEVELS[options.confiabilidade]:''}\n`);
    const summary=await rag.report(connection,questions,{reliability:options.confiabilidade});
    if(summary.nenhuma) console.log('Perguntas sem trecho: acrescente esse assunto à base ou reescreva o texto com as palavras do cliente.');
  } finally {await connection.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
