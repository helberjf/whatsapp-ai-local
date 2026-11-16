// Ciclo de vida da base: exclusão, atualização pela pasta, duplicatas e entradas vazias.
// Usa uma pasta temporária como "base-conhecimento". Saída: results/lifecycle.json
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {snapshot,createInstance,normalize}=require('./harness.cjs');
const data=require('./dataset.cjs');
const doc=name=>data.synthetic.documents.find(item=>item.name===name);
const brief=list=>list.map(item=>`${item.docName}#${item.index}:${item.confidence}:${item.via.join('+')}`);

(async()=>{
  const prod=snapshot(),folder=fs.mkdtempSync(path.join(os.tmpdir(),'rag-audit-pasta-')),output={},rules=prod.assistant.rules;
  for(const item of prod.documents) fs.writeFileSync(path.join(folder,item.name),item.text);
  for(const name of ['tabela-precos-2025.md','tabela-precos-2026.md']) fs.writeFileSync(path.join(folder,name),doc(name).text);
  const instance=await createInstance({documents:[],products:prod.products,folder,ai:prod.ai}),{embeddings}=instance.services;
  const ask=async question=>{const result=await instance.call('POST','/api/kb/ask',{question},{rules:async()=>rules});return {answer:result.answer,sources:result.sources.map(item=>item.doc+':'+item.confidence),ms:result.ms};};
  const list=async()=>(await instance.call('GET','/api/kb')).documents;

  // ---------- Exclusão ----------
  const question='Quanto custa a manutenção mensal do site?',before=await embeddings.search(question,{limit:10});
  const old=(await list()).find(item=>item.name==='tabela-precos-2025.md');
  await instance.call('DELETE','/api/kb?id='+old.id);
  const right=await embeddings.search(question,{limit:10});await embeddings.idle();
  output.delete={antes:brief(before).filter(item=>item.includes('2025')),logoDepois:brief(right).filter(item=>item.includes('2025')),documentosNoIndice:(await embeddings.status()),resposta:await ask(question)};
  console.log('EXCLUSÃO',JSON.stringify(output.delete));

  // ---------- Atualização pela pasta ----------
  const updated=doc('tabela-precos-2026.md').text.replace('R$ 55,00','R$ 60,00');
  fs.writeFileSync(path.join(folder,'tabela-precos-2026.md'),updated);
  const sync=await instance.call('POST','/api/kb/sync',{}),hosting='Quanto é a hospedagem por mês?';
  const during=await embeddings.search(hosting,{limit:10}),statusDuring=await embeddings.status();
  await embeddings.idle();const after=await embeddings.search(hosting,{limit:10});
  const has=(results,value)=>results.filter(item=>item.docName==='tabela-precos-2026.md' && item.text.includes(value)).length;
  output.update={sync:{added:sync.added,updated:sync.updated,unchanged:sync.unchanged},durante:{status:statusDuring.mode+' '+statusDuring.indexed+'/'+statusDuring.total,novo:has(during,'R$ 60,00'),antigo:has(during,'R$ 55,00'),top:brief(during).slice(0,3)},depois:{novo:has(after,'R$ 60,00'),antigo:has(after,'R$ 55,00'),top:brief(after).slice(0,3)},resposta:await ask(hosting)};
  console.log('ATUALIZAÇÃO',JSON.stringify(output.update));

  // ---------- Duplicatas: o mesmo texto enviado duas vezes pela tela ----------
  const again=doc('tabela-precos-2026.md').text.replace('R$ 55,00','R$ 60,00');
  const first=await instance.call('POST','/api/kb',{name:'tabela-precos-2026 (cópia).md',text:again});await embeddings.idle();
  const sent=await embeddings.search(hosting,{reliability:'balanced'}),texts=sent.map(item=>normalize(item.text));
  output.duplicate={aceito:Boolean(first.id),enviados:brief(sent),trechosRepetidos:texts.length-new Set(texts).size,documentos:(await list()).length};
  console.log('DUPLICATA',JSON.stringify(output.duplicate));

  // ---------- Entradas vazias ou inválidas ----------
  output.invalid={};
  for(const [label,input] of [['texto em branco',{name:'vazio',text:'   \n  '}],['PDF sem texto',{name:'escaneado.pdf',base64:Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n').toString('base64')}],['extensão não suportada',{name:'planilha.xlsx',base64:Buffer.from('PK').toString('base64')}]]) {
    try {await instance.call('POST','/api/kb',input);output.invalid[label]='ACEITO';}catch(error) {output.invalid[label]=`recusado (${error.status}): ${error.message}`;}
  }
  output.invalid['pergunta só com palavras vazias']=(await embeddings.search('e para que',{reliability:'balanced'})).length+' trechos';
  console.log('INVÁLIDOS',JSON.stringify(output.invalid));
  await instance.close();fs.rmSync(folder,{recursive:true,force:true});
  fs.writeFileSync(path.join(__dirname,'results','lifecycle.json'),JSON.stringify(output,null,1));
})().catch(error=>{console.error(error);process.exit(1);});
