// Grava um teste de navegador clicando na demo (dados fictícios, sem WhatsApp nem IA real).
// Uso: npm run codegen   ou   npm run codegen -- minha-gravacao
// O arquivo fica em tests/recordings/, fora da suíte: copie os passos para tests/e2e/ usando a fixture `demo`.
const path=require('node:path');
const fs=require('node:fs/promises');
const {spawn}=require('node:child_process');
const {createDemo}=require('./demo.cjs');

async function main() {
  const name=(process.argv[2] || 'gravacao-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')).replace(/[^\w-]/g,'');
  const output=path.join(__dirname,'..','tests','recordings',name+'.spec.cjs');
  await fs.mkdir(path.dirname(output),{recursive:true});
  const demo=await createDemo({port:Number(process.env.WHATSAPP_DEMO_PORT) || 8877});
  console.log(`Demo em ${demo.base}. Clique no navegador que abriu; feche-o para salvar ${output}`);
  try {
    const cli=path.join(path.dirname(require.resolve('@playwright/test/package.json')),'cli.js');
    await new Promise((resolve,reject)=>spawn(process.execPath,[cli,'codegen','--target','playwright-test','--lang','pt-BR','--output',output,demo.base],{stdio:'inherit'}).on('exit',resolve).on('error',reject));
  } finally {await demo.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
