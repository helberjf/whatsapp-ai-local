// Ingestão sem IA: (1) PDF real gerado pelo Chrome passa pelo extrator do app; (2) estatísticas dos trechos;
// (3) custo da parte de palavras-chave da busca com uma base grande. Saída: results/ingestion.json
const fs=require('node:fs');
const path=require('node:path');
const {knowledge,snapshot,percentile}=require('./harness.cjs');
const data=require('./dataset.cjs');
const words=text=>(knowledge.normalize(text).match(/[a-z0-9]{4,}/g) || []);
const html=markdown=>'<html><body style="font:14px Arial;margin:40px">'+markdown.split(/\n{2,}/).map(block=>block.startsWith('#')?`<h2>${block.replace(/^#+\s*/,'')}</h2>`:/^(- |\d+\. )/.test(block)?'<ul>'+block.split('\n').map(line=>`<li>${line.replace(/^(- |\d+\. )/,'')}</li>`).join('')+'</ul>':`<p>${block}</p>`).join('').replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')+'</body></html>';

(async()=>{
  const prod=snapshot(),output={pdf:[],chunks:[],scale:[]};
  // ---------- 1. PDF ----------
  const {chromium}=require('@playwright/test'),browser=await chromium.launch(),page=await browser.newPage();
  const table='<html><body style="font:14px Arial;margin:40px"><h2>Tabela de preços</h2><table border="1" cellpadding="6"><tr><th>Código</th><th>Produto</th><th>Preço</th><th>Garantia</th></tr>'+data.synthetic.documents.find(doc=>doc.csv).csv.split('\n').slice(1).map(line=>{const [code,name,price,warranty]=line.split(';');return `<tr><td>${code}</td><td>${name}</td><td>R$ ${price}</td><td>${warranty}</td></tr>`;}).join('')+'</table></body></html>';
  const cases=[...prod.documents.map(doc=>({name:doc.name.replace(/\.md$/,'.pdf'),source:doc.text,html:html(doc.text)})),{name:'tabela-pecas.pdf',source:data.synthetic.documents.find(doc=>doc.csv).csv.replace(/;/g,' '),html:table}];
  for(const item of cases) {
    await page.setContent(item.html);const buffer=await page.pdf({format:'A4'}),row={name:item.name,bytes:buffer.length};
    try {
      const text=knowledge.extractText(item.name,buffer),original=words(item.source),extracted=new Set(words(text));
      row.chars=text.length;row.wordRecall=Number((original.filter(word=>extracted.has(word)).length/original.length).toFixed(3));
      row.missing=[...new Set(original.filter(word=>!extracted.has(word)))].slice(0,12);row.sample=text.slice(0,220);
      if(item.name==='tabela-pecas.pdf') row.rowsIntact=data.synthetic.documents.find(doc=>doc.csv).csv.split('\n').slice(1).filter(line=>{const [code,name,price]=line.split(';'),flat=knowledge.normalize(text).replace(/\s+/g,' '),at=flat.indexOf(knowledge.normalize(code));return at>=0 && flat.slice(at,at+120).includes(knowledge.normalize(price));}).length+'/12';
    } catch(error) {row.error=error.message;}
    output.pdf.push(row);console.log('PDF',JSON.stringify(row).slice(0,400));
  }
  await browser.close();
  // ---------- 2. Trechos da base real ----------
  for(const doc of prod.documents) {
    const chunks=knowledge.chunkText(doc.text);
    const midWord=chunks.slice(1).filter((chunk,index)=>{const previous=chunks[index],tail=previous.slice(-120),cut=previous.length-120;return cut>0 && /[\p{L}\p{N}]/u.test(previous[cut-1]) && /[\p{L}\p{N}]/u.test(tail[0]);}).length;
    const headings=[...doc.text.matchAll(/^## (.+)$/gm)].map(match=>match[1]),orphans=chunks.filter(chunk=>!/^#/.test(chunk.trim()) && !headings.some(heading=>chunk.indexOf('## '+heading)===0)).length;
    // Seção cujo conteúdo continua em um trecho que não repete o título da seção.
    const split=headings.filter(heading=>{const start=doc.text.indexOf('## '+heading),next=doc.text.indexOf('\n## ',start+3),body=doc.text.slice(start,next<0?undefined:next).trim(),lastLine=body.split('\n').filter(Boolean).at(-1).slice(-60);return chunks.some(chunk=>chunk.includes(lastLine) && !chunk.includes('## '+heading));}).length;
    output.chunks.push({doc:doc.name,chars:doc.text.length,chunks:chunks.length,sizes:chunks.map(chunk=>chunk.length),overlapStartsMidWord:midWord+'/'+(chunks.length-1),sections:headings.length,sectionsContinuedWithoutTitle:split});
    console.log('TRECHOS',JSON.stringify(output.chunks.at(-1)));
  }
  // ---------- 3. Escala da busca por palavras (o app refaz chunking e tokenização a cada pergunta) ----------
  const filler=prod.documents.map(doc=>doc.text).join('\n\n');
  for(const [count,size] of [[4,2600],[20,50_000],[60,200_000],[60,1_500_000]]) {
    const docs=Array.from({length:count},(_,index)=>({id:'d'+index,name:'doc'+index+'.md',text:Array.from({length:Math.ceil(size/filler.length)},()=>filler).join('\n\n').slice(0,size)}));
    const times=[];for(let run=0;run<(size>500_000?2:5);run++) {const started=process.hrtime.bigint();knowledge.search(docs,'quanto custa trazer mercadoria da china',20);times.push(Number(process.hrtime.bigint()-started)/1e6);}
    const chunks=docs.reduce((sum,doc)=>sum+knowledge.chunkText(doc.text).length,0);
    output.scale.push({docs:count,charsPerDoc:size,totalMB:Number((count*size/1e6).toFixed(1)),chunks,bm25MsP50:Math.round(percentile(times,50)),estimatedIndexMinutes:Number((chunks*1.6/60).toFixed(0))});
    console.log('ESCALA',JSON.stringify(output.scale.at(-1)));
  }
  fs.mkdirSync(path.join(__dirname,'results'),{recursive:true});fs.writeFileSync(path.join(__dirname,'results','ingestion.json'),JSON.stringify(output,null,1));
})().catch(error=>{console.error(error);process.exit(1);});
