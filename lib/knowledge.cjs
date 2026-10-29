const zlib=require('node:zlib');
const {ApiError}=require('./evolution.cjs');

const MAX_TEXT_CHARS=1_500_000;
const STOP=new Set('a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sob sobre e ou mas que se ao aos à às é são foi ser tem ter qual quais quanto quanta quantos quantas como onde quando seu sua seus suas meu minha me te lhe isso isto esse essa este esta pelo pela'.split(' '));
const normalize=text=>String(text).normalize('NFD').replace(/[̀-ͯ]/g,'').toLocaleLowerCase('pt-BR');
// Remove o plural simples ("produtos" → "produto") para a busca tolerar variações.
const stem=token=>token.length>3 && token.endsWith('s')?token.slice(0,-1):token;
const tokenize=text=>(normalize(text).match(/[a-z0-9]+/g) || []).filter(token=>token.length>1 && !STOP.has(token)).map(stem);

function chunkText(text,max=1000,overlap=120) {
  const paragraphs=text.replace(/\r\n?/g,'\n').split(/\n{2,}/).map(part=>part.trim()).filter(Boolean);
  const pieces=[];
  for(const paragraph of paragraphs) {
    if(paragraph.length<=max) {pieces.push(paragraph);continue;}
    let buffer='';
    for(const sentence of paragraph.split(/(?<=[.!?;\n])\s+/)) {
      if(buffer && buffer.length+sentence.length+1>max) {pieces.push(buffer);buffer='';}
      if(sentence.length>max) {for(let index=0;index<sentence.length;index+=max) pieces.push(sentence.slice(index,index+max));}
      else buffer=buffer?buffer+' '+sentence:sentence;
    }
    if(buffer) pieces.push(buffer);
  }
  const chunks=[];let current='';
  for(const piece of pieces) {
    if(current && current.length+piece.length+2>max) {chunks.push(current);current=current.slice(-overlap)+'\n\n'+piece;}
    else current=current?current+'\n\n'+piece:piece;
  }
  if(current) chunks.push(current);
  return chunks;
}

function unzipEntry(buffer,wanted) {
  let end=-1;
  for(let index=buffer.length-22;index>=Math.max(0,buffer.length-65_557);index--) if(buffer.readUInt32LE(index)===0x06054b50) {end=index;break;}
  if(end<0) throw new ApiError('Arquivo DOCX inválido.',422);
  let offset=buffer.readUInt32LE(end+16);
  for(let entry=0,total=buffer.readUInt16LE(end+10);entry<total;entry++) {
    if(buffer.readUInt32LE(offset)!==0x02014b50) break;
    const method=buffer.readUInt16LE(offset+10),size=buffer.readUInt32LE(offset+20),nameLength=buffer.readUInt16LE(offset+28),extraLength=buffer.readUInt16LE(offset+30),commentLength=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42);
    const name=buffer.toString('utf8',offset+46,offset+46+nameLength);
    if(name===wanted) {
      const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28),data=buffer.subarray(start,start+size);
      // Limite de saída evita que um arquivo comprimido malicioso consuma toda a memória.
      return method===0?data:zlib.inflateRawSync(data,{maxOutputLength:30*1024*1024});
    }
    offset+=46+nameLength+extraLength+commentLength;
  }
  throw new ApiError('O DOCX não contém texto legível.',422);
}
const xmlText=xml=>xml.replace(/<w:tab\s*\/>/g,'\t').replace(/<w:br\s*\/>/g,'\n').replace(/<\/w:p>/g,'\n\n').replace(/<[^>]+>/g,'')
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');

const extension=name=>String(name).toLowerCase().split('.').pop();
const SUPPORTED=['txt','md','markdown','csv','json','docx'];

function extractText(name,buffer) {
  const type=extension(name);
  if(type==='pdf') throw new ApiError('PDF ainda não é lido por esta central. Exporte o catálogo como DOCX ou TXT, ou cole o texto.',415);
  if(!SUPPORTED.includes(type)) throw new ApiError('Use arquivos TXT, MD, CSV, JSON ou DOCX.',415);
  let text;
  if(type==='docx') text=xmlText(unzipEntry(buffer,'word/document.xml').toString('utf8'));
  else text=buffer.toString('utf8').replace(/^﻿/,'');
  if(type==='csv') text=csvToSentences(text);
  text=text.replace(/\u0000/g,'').trim();
  if(!text) throw new ApiError('Não encontrei texto neste arquivo.',422);
  if(text.length>MAX_TEXT_CHARS) throw new ApiError('Arquivo muito grande para a base. Divida-o em partes menores.',413);
  return text;
}

// Cada linha da planilha vira "coluna: valor" para o contexto continuar compreensível depois de dividido em partes.
function csvToSentences(text) {
  const rows=[];let row=[],cell='',quoted=false;
  const delimiter=(text.split('\n')[0].match(/;/g) || []).length>(text.split('\n')[0].match(/,/g) || []).length?';':',';
  for(let index=0;index<text.length;index++) {
    const char=text[index];
    if(quoted) {if(char==='"' && text[index+1]==='"') {cell+='"';index++;}else if(char==='"') quoted=false;else cell+=char;}
    else if(char==='"') quoted=true;
    else if(char===delimiter) {row.push(cell);cell='';}
    else if(char==='\n' || char==='\r') {if(char==='\r' && text[index+1]==='\n') index++;row.push(cell);cell='';if(row.some(value=>value.trim())) rows.push(row);row=[];}
    else cell+=char;
  }
  row.push(cell);if(row.some(value=>value.trim())) rows.push(row);
  if(rows.length<2) return text;
  const header=rows[0].map(value=>value.trim());
  return rows.slice(1).map(values=>header.map((name,index)=>values[index]?.trim()?`${name || 'Coluna '+(index+1)}: ${values[index].trim()}`:'').filter(Boolean).join('; ')).join('\n\n');
}

// BM25 sobre as partes de todos os documentos. Resultado: partes ordenadas com relevância de 0 a 1.
function search(documents,query,limit=5) {
  const terms=[...new Set(tokenize(query))];if(!terms.length) return [];
  const parts=[];
  for(const doc of documents) chunkText(doc.text).forEach((text,index)=>parts.push({docId:doc.id,docName:doc.name,index,text,tokens:tokenize(text)}));
  if(!parts.length) return [];
  const average=parts.reduce((sum,part)=>sum+part.tokens.length,0)/parts.length || 1;
  const frequency=new Map();for(const term of terms) frequency.set(term,parts.filter(part=>part.tokens.includes(term)).length);
  const scored=parts.map(part=>{
    const counts=new Map();for(const token of part.tokens) counts.set(token,(counts.get(token) || 0)+1);
    let score=0;
    for(const term of terms) {
      const tf=counts.get(term) || 0;if(!tf) continue;
      const idf=Math.log(1+(parts.length-frequency.get(term)+.5)/(frequency.get(term)+.5));
      score+=idf*(tf*2.2)/(tf+1.2*(.25+.75*part.tokens.length/average));
    }
    return {docId:part.docId,docName:part.docName,index:part.index,text:part.text,score};
  }).filter(part=>part.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);
  const top=scored[0]?.score || 1;
  return scored.map(part=>({...part,relevance:Number((part.score/top).toFixed(2))}));
}

module.exports={extractText,chunkText,search,tokenize,normalize,SUPPORTED,MAX_TEXT_CHARS};
