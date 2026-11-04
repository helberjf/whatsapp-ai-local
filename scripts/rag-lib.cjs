// Peças compartilhadas pelos scripts de RAG: modelos por tipo de negócio, texto da base e conexão com a central.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createKnowledgeRoutes}=require('../lib/knowledge-routes.cjs');

const root=path.join(__dirname,'..');
// O aviso experimental do SQLite (cofre de chaves da central) só polui a saída dos assistentes.
process.removeAllListeners('warning');process.on('warning',warning=>{if(warning.name!=='ExperimentalWarning') console.warn(warning.message);});
const DEFAULTS={dados:path.join(root,'data'),pasta:path.join(root,'base-conhecimento'),catalogo:path.join(root,'produtos-iniciais.json'),app:'http://127.0.0.1:8766'};
const PROFILE_FILE='00-sobre-o-negocio.md',QUESTIONS_FILE=path.join('testes','perguntas.txt');

// Perguntas comuns por tipo de negócio. Cada modelo acrescenta perguntas próprias e as dúvidas usadas no teste da base.
const COMMON=[
  {key:'endereco',label:'Cidade e endereço',heading:'Endereço'},
  {key:'horario',label:'Horário de funcionamento',heading:'Horário de funcionamento'},
  {key:'contato',label:'Telefone, site ou redes sociais',heading:'Contato'},
  {key:'pagamento',label:'Formas de pagamento',heading:'Formas de pagamento'},
  {key:'ofertas',label:'Principais produtos ou serviços, com preços se quiser (separe com ;)',heading:'Produtos e serviços',list:true},
  {key:'politicas',label:'Políticas (trocas, cancelamento, atrasos, garantia)',heading:'Políticas'},
  {key:'diferenciais',label:'Diferenciais do negócio',heading:'Diferenciais'}
];
const TEMPLATES={
  restaurante:{label:'Restaurante, lanchonete ou delivery',extras:[{key:'entrega',label:'Entrega: bairros atendidos, taxa e tempo médio',heading:'Entrega'},{key:'cardapio',label:'Opções especiais (vegetariano, sem glúten, infantil)',heading:'Opções especiais'}],questions:['Vocês entregam no meu bairro?','Qual o valor da taxa de entrega?','Tem opção vegetariana?','Que horas vocês abrem?','Aceita cartão?','Qual o prato mais pedido?']},
  loja:{label:'Loja ou comércio',extras:[{key:'entrega',label:'Entrega ou retirada: prazos e frete',heading:'Entrega e retirada'},{key:'trocas',label:'Trocas e devoluções',heading:'Trocas e devoluções'}],questions:['Vocês fazem entrega?','Posso trocar se não servir?','Qual o horário da loja?','Parcela no cartão?','Tem esse produto em estoque?','Onde fica a loja?']},
  clinica:{label:'Clínica, consultório ou saúde',extras:[{key:'convenios',label:'Convênios aceitos',heading:'Convênios'},{key:'agendamento',label:'Como agendar, remarcar ou cancelar consultas',heading:'Agendamento'}],questions:['Vocês atendem pelo meu plano de saúde?','Como marco uma consulta?','Quanto custa a consulta particular?','Posso remarcar meu horário?','Qual o endereço da clínica?','Atende no sábado?']},
  salao:{label:'Salão, barbearia ou estética',extras:[{key:'agendamento',label:'Como agendar e política de atrasos',heading:'Agendamento'},{key:'profissionais',label:'Profissionais e especialidades',heading:'Profissionais'}],questions:['Quanto custa um corte?','Tem horário amanhã?','Como faço para agendar?','Aceita pix?','Faz progressiva?','Se eu atrasar, perco o horário?']},
  oficina:{label:'Oficina ou assistência técnica',extras:[{key:'marcas',label:'Marcas, modelos ou equipamentos atendidos',heading:'Atendimento técnico'},{key:'orcamento',label:'Como funciona o orçamento e a garantia do serviço',heading:'Orçamento e garantia'}],questions:['Vocês consertam a minha marca?','O orçamento é grátis?','Quanto tempo demora o conserto?','O serviço tem garantia?','Precisa agendar?','Onde vocês ficam?']},
  academia:{label:'Academia, estúdio ou esportes',extras:[{key:'planos',label:'Planos, mensalidades e matrícula',heading:'Planos'},{key:'aulas',label:'Aulas, modalidades e aula experimental',heading:'Aulas e modalidades'}],questions:['Quanto é a mensalidade?','Tem aula experimental?','Quais modalidades vocês têm?','Qual o horário de funcionamento?','Tem plano anual?','Preciso de exame médico?']},
  escola:{label:'Escola, cursos ou aulas particulares',extras:[{key:'cursos',label:'Cursos, turmas e duração',heading:'Cursos e turmas'},{key:'matricula',label:'Matrícula, documentos e valores',heading:'Matrícula'}],questions:['Quais cursos vocês oferecem?','Quanto custa a mensalidade?','Como faço a matrícula?','Tem aula online?','Quando começa a próxima turma?','Tem certificado?']},
  servicos:{label:'Prestador de serviços (geral)',extras:[{key:'atendimento',label:'Onde atende (domicílio, online, escritório) e prazos',heading:'Como atendemos'},{key:'orcamento',label:'Como pedir orçamento',heading:'Orçamento'}],questions:['Quanto custa o serviço?','Vocês atendem na minha cidade?','Como peço um orçamento?','Qual o prazo?','Trabalham no fim de semana?','Como posso pagar?']},
  outro:{label:'Outro tipo de negócio',extras:[{key:'atendimento',label:'Como é o atendimento e o que o cliente precisa saber',heading:'Atendimento'}],questions:['O que vocês oferecem?','Qual o horário de atendimento?','Como posso pagar?','Onde vocês ficam?','Como faço um pedido?','Quanto custa?']}
};

const clean=value=>typeof value==='string'?value.trim():'';
// Uma seção por assunto, em frases completas: assim a busca por palavras e a por significado acham o trecho certo.
function buildProfile(answers) {
  const name=clean(answers.nome),template=TEMPLATES[answers.tipo];
  if(!name) throw new Error('Informe o nome do estabelecimento.');
  if(!template) throw new Error('Tipo de negócio inválido. Use: '+Object.keys(TEMPLATES).join(', ')+'.');
  const lines=[`# ${name}`,'',`Tipo de negócio: ${template.label}.${clean(answers.descricao)?' '+clean(answers.descricao):''}`];
  for(const item of [...COMMON,...template.extras]) {
    const value=clean(answers[item.key]);if(!value) continue;
    const body=item.list?value.split(';').map(part=>part.trim()).filter(Boolean).map(part=>`- ${part}`).join('\n'):`${item.heading} de ${name}: ${value}`;
    lines.push('',`## ${item.heading}`,'',body);
  }
  lines.push('','## Atendimento humano','',`Quando a informação não estiver nesta base, um atendente de ${name} confirma pelo WhatsApp.`);
  return lines.join('\n')+'\n';
}

// Usa a central aberta pela API local; sem ela, abre a base direto na pasta de dados (mesmo código da central).
async function connect({dados=DEFAULTS.dados,pasta=DEFAULTS.pasta,catalogo=DEFAULTS.catalogo,app=DEFAULTS.app}={}) {
  let token=null;
  try {const page=await (await fetch(app,{signal:AbortSignal.timeout(2500)})).text();token=page.match(/name="whatsapp-session" content="([a-f0-9]{64})"/)?.[1] || null;} catch {}
  if(token) {
    const call=async(route,method='GET',input)=>{
      const response=await fetch(app.replace(/\/$/,'')+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},...(input===undefined?{}:{body:JSON.stringify(input)})}),body=await response.json();
      if(!response.ok) throw new Error(body.error || 'A central recusou a operação.');return body;
    };
    return {
      mode:'app',
      sync:()=>call('/api/kb/sync','POST',{}),
      async status() {for(let attempt=0;attempt<600;attempt++) {const {search}=await call('/api/kb');if(!search.indexing) return search;await new Promise(resolve=>setTimeout(resolve,1000));}return (await call('/api/kb')).search;},
      search:async(query,reliability)=>(await call('/api/kb/search','POST',{query,...(reliability?{reliability}:{})})).results,
      close:async()=>{}
    };
  }
  const knowledge=createKnowledgeRoutes(dados,globalThis.fetch,{knowledgeDir:pasta,catalogFile:catalogo}),{services}=knowledge;
  await services.ready();
  return {
    mode:'offline',
    async sync() {return (await knowledge({method:'POST'},'/api/kb/sync',new URL('http://local/api/kb/sync'),async()=>({}))).body;},
    async status() {services.embeddings.refresh();await services.embeddings.idle();return services.embeddings.status();},
    search:(query,reliability)=>services.embeddings.search(query,{reliability}),
    async close() {await services.embeddings.close();await services.ai.close();}
  };
}

async function readQuestions(file) {return (await fs.readFile(file,'utf8').catch(()=>'')).split(/\r?\n/).map(line=>line.trim()).filter(line=>line && !line.startsWith('#'));}
function parseArgs(argv) {
  const options={};
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];if(!arg.startsWith('--')) continue;
    const key=arg.slice(2),next=argv[index+1];
    if(next===undefined || next.startsWith('--')) options[key]=true;else {options[key]=next;index++;}
  }
  return options;
}
const LABELS={alta:'alta',media:'média',baixa:'baixa'};
// Resultado de cada pergunta em uma linha; devolve o resumo por nível de confiança.
async function report(connection,questions,{reliability,log=console.log}={}) {
  const summary={alta:0,media:0,baixa:0,nenhuma:0};
  for(const question of questions) {
    const [top]=await connection.search(question,reliability),level=top?.confidence || 'nenhuma';summary[level]++;
    log(top?`  [${LABELS[level].padEnd(5)}] ${question}\n          → ${top.docName}${top.via?.includes('semantic')?' (por significado)':''}: ${top.text.replace(/\s+/g,' ').slice(0,90)}…`:`  [nada ] ${question}\n          → nenhum trecho encontrado`);
  }
  log(`\nResumo: ${summary.alta} alta · ${summary.media} média · ${summary.baixa} baixa · ${summary.nenhuma} sem trecho, de ${questions.length} perguntas.`);
  return summary;
}
module.exports={DEFAULTS,PROFILE_FILE,QUESTIONS_FILE,COMMON,TEMPLATES,buildProfile,connect,readQuestions,parseArgs,report};
