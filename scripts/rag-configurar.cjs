// Assistente de linha de comando: monta a base de conhecimento de qualquer estabelecimento e prepara a busca.
// Uso: npm run rag:configurar   (opções: --respostas arquivo.json --baixar-modelo --sem-modelo --dados --pasta --app)
const fs=require('node:fs/promises');
const path=require('node:path');
const readline=require('node:readline/promises');
const {spawn}=require('node:child_process');
const {EMBEDDINGS}=require('../lib/ai.cjs');
const rag=require('./rag-lib.cjs');

const OLLAMA='http://127.0.0.1:11434';
const exists=file=>fs.access(file).then(()=>true,()=>false);

async function ask(prompts,options) {
  if(options.respostas) return JSON.parse(await fs.readFile(options.respostas,'utf8'));
  const answers={};
  console.log('Responda o que souber. Deixe em branco para pular; dá para editar o arquivo depois.\n');
  answers.nome=await prompts.question('Nome do estabelecimento: ');
  const types=Object.entries(rag.TEMPLATES);
  types.forEach(([,template],index)=>console.log(`  ${index+1}. ${template.label}`));
  const choice=Number(await prompts.question(`Tipo de negócio (1-${types.length}): `));
  answers.tipo=types[choice-1]?.[0] || 'outro';
  answers.descricao=await prompts.question('Em uma frase, o que o negócio faz: ');
  for(const item of [...rag.COMMON,...rag.TEMPLATES[answers.tipo].extras]) answers[item.key]=await prompts.question(item.label+': ');
  return answers;
}
async function confirm(prompts,question,fallback) {
  if(!prompts) return fallback;
  return /^s(im)?$/i.test((await prompts.question(question+' [s/N] ')).trim());
}
// Descobre, pela própria central, qual modelo de embeddings ela vai usar e, se for o Ollama local, confere se ele está instalado.
async function checkModel(connection,options,prompts) {
  const config=await connection.aiConfig();
  if(!config.configured) {console.log('\nIA ainda não configurada. Abra a central em Assistente de IA e escolha Ollama (local) para buscar por significado sem enviar dados para fora. Até lá, a busca usa palavras-chave.');return;}
  const model=config.embeddingModel || EMBEDDINGS[config.provider];
  if(!model || model==='off') {console.log('\nSem modelo de embeddings para este provedor: a busca usa só palavras-chave. Informe um em Assistente de IA → Modelo de embeddings.');return;}
  if(!['ollama','anthropic'].includes(config.provider)) {console.log(`\nEmbeddings: ${model} pelo provedor ${config.providers?.[config.provider]?.label || config.provider}. Os textos da base serão enviados a ele na indexação.`);return;}
  let tags;try {tags=await (await fetch(OLLAMA+'/api/tags',{signal:AbortSignal.timeout(3000)})).json();} catch {console.log('\nO Ollama não respondeu em '+OLLAMA+'. Abra o Ollama e rode este assistente de novo para ativar a busca por significado.');return;}
  if((tags.models || []).some(item=>item.name===model || item.name===model+':latest')) {console.log(`\nModelo de embeddings ${model} instalado no Ollama.`);return;}
  if(options['sem-modelo'] || !(options['baixar-modelo'] || await confirm(prompts,`\nO modelo ${model} não está no Ollama. Baixar agora (cerca de 1,2 GB para o bge-m3)?`,false))) {console.log(`Sem o modelo, a busca usa só palavras-chave. Para instalar depois: ollama pull ${model}`);return;}
  const installed=process.platform==='win32'?path.join(process.env.LOCALAPPDATA || '','Programs','Ollama','ollama.exe'):'ollama',command=await exists(installed)?installed:'ollama';
  await new Promise((resolve,reject)=>spawn(command,['pull',model],{stdio:'inherit'}).on('exit',code=>code===0?resolve():reject(new Error('ollama pull terminou com código '+code))).on('error',reject));
}

async function main() {
  const options={...rag.DEFAULTS,...rag.parseArgs(process.argv.slice(2))};
  const prompts=options.respostas?null:readline.createInterface({input:process.stdin,output:process.stdout});
  try {
    console.log('Configuração da base de conhecimento (RAG)\n');
    const answers=await ask(prompts,options),profile=rag.buildProfile(answers);
    const target=path.join(options.pasta,rag.PROFILE_FILE),questions=path.join(options.pasta,rag.QUESTIONS_FILE);
    if(await exists(target) && !await confirm(prompts,`${target} já existe. Substituir?`,true)) throw new Error('Nada foi alterado.');
    await fs.mkdir(path.dirname(questions),{recursive:true});await fs.writeFile(target,profile);
    console.log(`\nBase do negócio salva em ${target}`);
    // A pasta "testes" não entra na base: guarda as perguntas usadas para conferir a busca.
    if(!await exists(questions)) {await fs.writeFile(questions,'# Uma pergunta por linha, do jeito que o cliente escreveria.\n'+rag.TEMPLATES[answers.tipo].questions.join('\n')+'\n');console.log(`Perguntas de teste salvas em ${questions}`);}
    const others=(await fs.readdir(options.pasta)).filter(name=>/\.(md|txt|csv|json|docx|pdf)$/i.test(name) && name!==rag.PROFILE_FILE);
    if(others.length) console.log(`A pasta também tem ${others.length} outro(s) arquivo(s), que continuam na base: ${others.join(', ')}`);
    const connection=await rag.connect(options);
    try {
      await checkModel(connection,options,prompts);
      console.log(connection.mode==='app'?'\nCentral aberta: sincronizando pela central…':'\nCentral fechada: preparando a base direto na pasta de dados…');
      const synced=await connection.sync();
      console.log('Pasta sincronizada.'+(synced.failed?.length?' Falhas: '+synced.failed.join(' · '):''));
      const status=await connection.status();
      console.log(status.mode==='hybrid'?`Busca por palavras e por significado (${status.model}): ${status.indexed} de ${status.total} documentos.`:`Busca só por palavras-chave em ${status.total} documento(s)${status.error?' ('+status.error+')':''}.`);
      console.log('\nTeste com as perguntas de exemplo:');
      await rag.report(connection,await rag.readQuestions(questions));
      console.log('\nPróximos passos: revise o arquivo da base, ajuste as perguntas de teste e rode npm run rag:testar. Na central, escolha a confiabilidade na Base de Conhecimento.');
    } finally {await connection.close();}
  } finally {prompts?.close();}
}
main().catch(error=>{console.error('\n'+error.message);process.exitCode=1;});
