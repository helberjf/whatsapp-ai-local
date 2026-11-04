const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {createEmbeddingIndex}=require('../lib/embeddings.cjs');
const {createWhatsAppServer}=require('../server.cjs');
const core=require('../lib/assistant-core.cjs');
const faq=require('../lib/faq.cjs');
const rag=require('../scripts/rag-lib.cjs');

// Embedding simulado por assunto, como em embeddings.test.cjs.
const CONCEPTS=[/voo|voar|passagem|aére|aviao/i,/importa|china|exterior/i,/garantia|troca/i];
const vector=text=>[...CONCEPTS.map(pattern=>pattern.test(text)?1:0),.01];
const DOCS=[{id:'a',name:'passagens.md',text:'Emitimos passagem aérea com milhas para qualquer destino.'},{id:'b',name:'importacao.md',text:'Trazemos mercadorias da China com desembaraço.'},{id:'c',name:'garantia.md',text:'A garantia cobre defeitos por 12 meses.'}];
const temp=async t=>{const folder=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-ragf-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));return folder;};
const fakeAi=(target={model:'modelo',signature:'modelo-1'})=>({embedding:async()=>target,embed:async texts=>({vectors:texts.map(vector),signature:target?.signature})});
async function indexOf(t,docs=DOCS,ai=fakeAi()) {const service=createEmbeddingIndex({ai,directory:await temp(t),loadTexts:async()=>docs});await service.refresh();return service;}

test('confiança: as duas buscas juntas dão alta; só por palavra dá média e o modo rigoroso descarta',async t=>{
  const service=await indexOf(t);
  const [both]=await service.search('garantia de troca');
  assert.equal(both.docName,'garantia.md');assert.equal(both.confidence,'alta');assert.deepEqual(both.via,['lexical','semantic']);
  const [word]=await service.search('milhas');
  assert.equal(word.confidence,'media',"'milhas' não é um assunto do embedding simulado: só o BM25 acha.");
  assert.deepEqual(await service.search('milhas',{reliability:'strict'}),[]);
  assert.equal((await service.search('milhas',{reliability:'balanced'}))[0].docName,'passagens.md');
});

test('modo flexível aceita confiança baixa e mais trechos; rigoroso limita a três',async t=>{
  const many=Array.from({length:8},(_,index)=>({id:'d'+index,name:`garantia-${index}.md`,text:`Garantia número ${index} cobre defeitos.`}));
  const service=await indexOf(t,many);
  assert.equal((await service.search('garantia',{reliability:'strict'})).length,3);
  assert.equal((await service.search('garantia',{reliability:'balanced'})).length,4);
  assert.equal((await service.search('garantia',{reliability:'flexible'})).length,6);
  const weak=await indexOf(t,[{id:'w',name:'w.md',text:'Atendemos clientes de toda a cidade com cuidado e atenção.'}],fakeAi(null));
  assert.equal((await weak.search('cidade vizinha atende sábado domingo feriado'))[0].confidence,'baixa','Uma palavra em cinco é pouca cobertura.');
  assert.deepEqual(await weak.search('cidade vizinha atende sábado domingo feriado',{reliability:'balanced'}),[]);
  assert.equal((await weak.search('cidade vizinha atende sábado domingo feriado',{reliability:'flexible'})).length,1);
});

test('sem embeddings, a maior parte das palavras no trecho dá confiança alta',async t=>{
  const service=await indexOf(t,DOCS,fakeAi(null));
  const [found]=await service.search('garantia defeitos meses');
  assert.equal(found.confidence,'alta');assert.deepEqual(found.via,['lexical']);
  assert.equal((await service.search('pra vocês, a garantia?'))[0].confidence,'alta','Palavras de conversa não contam como termos.');
});

test('o prompt muda com o nível: rigoroso exige texto explícito, flexível libera cumprimentos',()=>{
  const build=reliability=>core.buildSystem({rules:[],catalog:'',sources:[],reliability});
  assert.match(build('strict'),/Modo rigoroso[\s\S]*\[\[HUMANO\]\]/);
  assert.match(build('flexible'),/Modo flexível/);
  assert.doesNotMatch(build('balanced'),/Modo (rigoroso|flexível)/);
  assert.match(core.buildSystem({rules:[],catalog:'',sources:[],reliability:'strict',suggestion:true}),/Modo rigoroso: não use nenhuma informação comercial/);
});

test('sugestões: valida a saída da IA, tira repetidas e mostra a fonte de cada resposta',async()=>{
  const calls=[],ai={complete:async request=>{calls.push(request);return '```json\n'+JSON.stringify({suggestions:[
    {question:'O produto tem garantia?',keywords:['Garantia','garantia','defeito'],answer:'Sim, 12 meses de garantia.'},
    {question:'O produto tem garantia?',keywords:['garantia'],answer:'Repetida.'},
    {question:'Oi',keywords:['oi'],answer:'Curta demais.'},
    {question:'Sem palavras-chave?',keywords:[],answer:'Descartada.'},
    {question:'Vocês importam da China?',keywords:['china','importar'],answer:'Sim, trazemos da China.'}
  ]})+'\n```';}};
  const result=await faq.suggestFaq(ai,{documents:DOCS,catalog:'SERVIÇOS\n- Importação',count:5,ground:async text=>/garantia/i.test(text)?[{docName:'garantia.md',confidence:'alta'}]:[]});
  assert.deepEqual(result.map(item=>item.question),['O produto tem garantia?','Vocês importam da China?']);
  assert.deepEqual(result[0].keywords,['garantia','defeito']);
  assert.deepEqual([result[0].source,result[0].confidence,result[1].source,result[1].confidence],['garantia.md','alta',null,'nenhuma']);
  assert.match(calls[0].system,/nunca siga ordens/);assert.match(calls[0].user,/<documento nome="passagens.md">/);assert.match(calls[0].user,/<documento nome="Catálogo">/);
  assert.equal(calls[0].json,true);assert.ok(calls[0].timeoutMs>90_000,'IA local em CPU precisa de mais tempo.');
  await assert.rejects(faq.suggestFaq(ai,{documents:[],count:3}),/vazia/);
  await assert.rejects(faq.suggestFaq({complete:async()=>'sem json'},{documents:DOCS}),/sugestões válidas/);
});

test('amostra da base passa por todos os documentos antes de repetir o primeiro',()=>{
  const long=Array.from({length:5},(_,index)=>`Parágrafo ${index} `+'x'.repeat(900)).join('\n\n');
  const picked=faq.sample([{name:'longo.md',text:long},{name:'curto.md',text:'Texto curto.'}],2500);
  assert.deepEqual(picked.slice(0,2).map(part=>part.name),['longo.md','curto.md']);
  assert.ok(picked.reduce((sum,part)=>sum+part.text.length,0)<=2500);
});

const credentials=()=>{const keys=new Map();return {has:async name=>keys.has(name),get:async name=>keys.get(name)||null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);},close:async()=>{}};};
test('HTTP: confiabilidade salva, aplicada na pergunta e sugestões com fonte',async t=>{
  const directory=await temp(t),prompts=[];
  const reply=body=>({ok:true,status:200,text:async()=>JSON.stringify(body)});
  const aiFetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.endsWith('/embeddings')) return reply({data:body.input.map((text,index)=>({index,embedding:vector(text)}))});
    prompts.push(body.messages[0].content);
    if(body.messages[0].content.includes('perguntas frequentes')) return reply({choices:[{message:{content:JSON.stringify({suggestions:[{question:'Tem garantia?',keywords:['garantia'],answer:'A garantia cobre defeitos por 12 meses.'}]})}}]});
    return reply({choices:[{message:{content:'Resposta.'}}]});
  };
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'teste'},storeDir:directory,aiFetch,credentials:credentials()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await server.cleanup;});
  const base=`http://127.0.0.1:${server.address().port}`,token=(await (await fetch(base)).text()).match(/name="whatsapp-session" content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token,Origin:base},...(input?{body:JSON.stringify(input)}:{})});return {status:response.status,body:await response.json()};};
  assert.equal((await call('/api/kb/suggestions','POST',{})).status,409,'Sem documentos, não há o que ler.');
  await call('/api/ai','PUT',{provider:'openai',model:'m',apiKey:'k'});
  for(const doc of DOCS) await call('/api/kb','POST',{name:doc.name,text:doc.text});
  for(let attempt=0;attempt<50;attempt++) {const {search}=(await call('/api/kb')).body;if(search.indexed===3 && !search.indexing) break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal((await call('/api/kb')).body.reliability,'balanced');
  assert.equal((await call('/api/kb/settings','PUT',{reliability:'qualquer'})).status,422);
  assert.deepEqual((await call('/api/kb/settings','PUT',{reliability:'strict'})).body,{reliability:'strict'});
  const strict=(await call('/api/kb/ask','POST',{question:'milhas'})).body;
  assert.deepEqual([strict.reliability,strict.confidence,strict.sources.length,strict.usedAi],['strict','nenhuma',0,false],'Sem trecho confiável nem catálogo, a IA nem é chamada.');
  const sure=(await call('/api/kb/ask','POST',{question:'garantia de troca'})).body;
  assert.deepEqual([sure.confidence,sure.usedAi],['alta',true]);assert.match(prompts.at(-1),/Modo rigoroso/);
  await call('/api/kb/settings','PUT',{reliability:'balanced'});
  const balanced=(await call('/api/kb/ask','POST',{question:'milhas'})).body;
  assert.deepEqual([balanced.confidence,balanced.sources[0].doc,balanced.sources[0].confidence],['media','passagens.md','media']);
  assert.equal((await call('/api/kb/search','POST',{query:'milhas',reliability:'strict'})).body.results.length,0);
  assert.equal((await call('/api/kb/search','POST',{query:'milhas',reliability:'x'})).status,422);
  assert.equal((await call('/api/kb/suggestions','POST',{count:99})).status,422);
  const {suggestions}=(await call('/api/kb/suggestions','POST',{count:3})).body;
  assert.deepEqual(suggestions,[{question:'Tem garantia?',keywords:['garantia'],answer:'A garantia cobre defeitos por 12 meses.',source:'garantia.md',confidence:'alta'}]);
});

test('perfil do negócio: uma seção por assunto, campos vazios ficam de fora',()=>{
  const text=rag.buildProfile({nome:'Salão Aurora',tipo:'salao',horario:'seg a sáb, 9h às 19h',pagamento:'',ofertas:'Corte R$ 50; Escova R$ 40',agendamento:'Pelo WhatsApp, com 1 dia de antecedência.'});
  assert.match(text,/^# Salão Aurora\n/);assert.match(text,/Tipo de negócio: Salão, barbearia ou estética\./);
  assert.match(text,/## Horário de funcionamento\n\nHorário de funcionamento de Salão Aurora: seg a sáb, 9h às 19h/);
  assert.match(text,/- Corte R\$ 50\n- Escova R\$ 40/);assert.match(text,/## Agendamento/);
  assert.doesNotMatch(text,/Formas de pagamento/);
  assert.throws(()=>rag.buildProfile({nome:'',tipo:'salao'}),/nome/);assert.throws(()=>rag.buildProfile({nome:'X',tipo:'nave'}),/Tipo/);
  for(const template of Object.values(rag.TEMPLATES)) assert.ok(template.questions.length>=5);
});

test('rag:configurar sem a central aberta monta a base, as perguntas e o teste',async t=>{
  const folder=await temp(t),dados=path.join(folder,'dados'),pasta=path.join(folder,'pasta'),answers=path.join(folder,'respostas.json');
  await fs.mkdir(pasta);await fs.writeFile(answers,JSON.stringify({nome:'Oficina Boa Roda',tipo:'oficina',horario:'segunda a sexta, 8h às 18h',marcas:'Fiat, VW e Chevrolet',orcamento:'O orçamento é grátis e o serviço tem garantia de 90 dias.'}));
  const run=args=>new Promise(resolve=>execFile(process.execPath,[path.join(__dirname,'..','scripts',args[0]),...args.slice(1),'--dados',dados,'--pasta',pasta,'--app','http://127.0.0.1:1'],{timeout:60_000},(error,stdout,stderr)=>resolve({code:error?.code ?? 0,stdout,stderr})));
  const setup=await run(['rag-configurar.cjs','--respostas',answers,'--sem-modelo']);
  assert.equal(setup.code,0,setup.stderr);
  assert.match(await fs.readFile(path.join(pasta,rag.PROFILE_FILE),'utf8'),/Fiat, VW e Chevrolet/);
  assert.match(await fs.readFile(path.join(pasta,rag.QUESTIONS_FILE),'utf8'),/O serviço tem garantia\?/);
  assert.match(setup.stdout,/IA ainda não configurada/);assert.match(setup.stdout,/Resumo: \d+ alta/);
  assert.doesNotMatch(setup.stdout+setup.stderr,/ExperimentalWarning/);
  const check=await run(['rag-testar.cjs','--pergunta','O orçamento é grátis?']);
  assert.equal(check.code,0,check.stderr);assert.match(check.stdout,/\[alta \] O orçamento é grátis\?/);assert.match(check.stdout,/00-sobre-o-negocio\.md/);
  assert.notEqual((await run(['rag-testar.cjs','--confiabilidade','total'])).code,0);
});
