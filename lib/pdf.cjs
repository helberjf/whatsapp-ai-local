const zlib=require('node:zlib');
const {ApiError}=require('./evolution.cjs');

// Leitor de texto de PDF sem dependências: objetos, fluxos Flate, ObjStm, fontes com ToUnicode e operadores de texto.
// Cobre PDFs gerados por Word, Chrome/Edge, LibreOffice e similares. PDFs escaneados (imagens) não têm texto a extrair.
const MAX_OUTPUT=30*1024*1024;

function inflate(data) {
  try {return zlib.inflateSync(data,{maxOutputLength:MAX_OUTPUT});}
  catch {try {return zlib.inflateRawSync(data,{maxOutputLength:MAX_OUTPUT});}catch {return null;}}
}

function readObjects(buffer) {
  const raw=buffer.toString('latin1'),objects=new Map(),pattern=/(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while((match=pattern.exec(raw))) {
    const start=match.index+match[0].length,end=raw.indexOf('endobj',start);if(end<0) break;
    const body=raw.slice(start,end),streamAt=body.search(/stream\r?\n/);
    let dict=body,data=null;
    if(streamAt>=0) {
      dict=body.slice(0,streamAt);
      const from=streamAt+body.slice(streamAt).indexOf('\n')+1,last=body.lastIndexOf('endstream');
      let bytes=Buffer.from(body.slice(from,last>from?last:body.length),'latin1');
      if(/\/FlateDecode/.test(dict)) bytes=inflate(bytes);
      else if(/\/Filter/.test(dict)) bytes=null;
      data=bytes;
    }
    objects.set(Number(match[1]),{dict,data});
    pattern.lastIndex=end+6;
  }
  // Objetos comprimidos dentro de ObjStm (PDF 1.5+).
  for(const [,object] of [...objects]) {
    if(!/\/Type\s*\/ObjStm/.test(object.dict) || !object.data) continue;
    const count=Number(object.dict.match(/\/N\s+(\d+)/)?.[1]),first=Number(object.dict.match(/\/First\s+(\d+)/)?.[1]);
    const text=object.data.toString('latin1'),numbers=text.slice(0,first).trim().split(/\s+/).map(Number);
    for(let index=0;index<count;index++) {
      const number=numbers[index*2],offset=numbers[index*2+1],next=numbers[index*2+3];
      objects.set(number,{dict:text.slice(first+offset,next===undefined?text.length:first+next),data:null});
    }
  }
  return objects;
}

const hexToUnicode=hex=>{const bytes=Buffer.from(hex.replace(/\s/g,''),'hex');let out='';for(let i=0;i+1<bytes.length;i+=2) out+=String.fromCharCode(bytes.readUInt16BE(i));return out;};
function parseToUnicode(text) {
  const map=new Map();let twoByte=false;
  for(const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for(const pair of block[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {if(pair[1].replace(/\s/g,'').length>2) twoByte=true;map.set(parseInt(pair[1],16),hexToUnicode(pair[2]));}
  }
  for(const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for(const row of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f\s]+>)/g)) {
      if(row[1].length>2) twoByte=true;
      const low=parseInt(row[1],16),high=parseInt(row[2],16);
      if(row[3].startsWith('[')) [...row[3].matchAll(/<([0-9A-Fa-f\s]+)>/g)].forEach((item,index)=>map.set(low+index,hexToUnicode(item[1])));
      else {const base=hexToUnicode(row[3].slice(1,-1));for(let code=low;code<=high&&code-low<65536;code++) map.set(code,base.slice(0,-1)+String.fromCharCode(base.charCodeAt(base.length-1)+code-low));}
    }
  }
  return {map,twoByte};
}

function unescapeLiteral(text) {
  let out='';
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(char!=='\\') {out+=char;continue;}
    const next=text[++i];
    if(next==='n') out+='\n';else if(next==='r') out+='\r';else if(next==='t') out+='\t';else if(next==='b') out+='\b';else if(next==='f') out+='\f';
    else if(next>='0' && next<='7') {let octal=next;while(octal.length<3 && text[i+1]>='0' && text[i+1]<='7') octal+=text[++i];out+=String.fromCharCode(parseInt(octal,8));}
    else if(next==='\n' || next==='\r') {if(next==='\r' && text[i+1]==='\n') i++;}
    else out+=next ?? '';
  }
  return out;
}

// Converte o conteúdo de uma página em texto.
function pageText(content,fonts) {
  let out='',font=null,i=0;const stack=[];
  const decode=bytes=>{
    if(font?.twoByte) {let s='';for(let k=0;k+1<bytes.length;k+=2) s+=font.map.get((bytes.charCodeAt(k)<<8)|bytes.charCodeAt(k+1)) ?? '';return s;}
    if(font?.map.size) return [...bytes].map(c=>font.map.get(c.charCodeAt(0)) ?? c).join('');
    return bytes;
  };
  const readString=()=>{
    if(content[i]==='(') {
      let depth=1,start=++i;
      while(i<content.length && depth>0) {if(content[i]==='\\') i++;else if(content[i]==='(') depth++;else if(content[i]===')') depth--;i++;}
      return unescapeLiteral(content.slice(start,i-1));
    }
    const end=content.indexOf('>',i),hex=content.slice(i+1,end).replace(/\s/g,'');i=end+1;
    return Buffer.from(hex.length%2?hex+'0':hex,'hex').toString('latin1');
  };
  while(i<content.length) {
    const char=content[i];
    if(char==='(' || (char==='<' && content[i+1]!=='<')) {stack.push({string:readString()});continue;}
    if(char==='<' || char===' ' || char==='\n' || char==='\r' || char==='\t' || char==='>') {i++;continue;}
    if(char==='[') {const items=[];i++;while(i<content.length && content[i]!==']') {if(content[i]==='(' || (content[i]==='<' && content[i+1]!=='<')) items.push({string:readString()});else {const m=/^-?\d*\.?\d+/.exec(content.slice(i,i+20));if(m) {items.push({number:Number(m[0])});i+=m[0].length;}else i++;}}i++;stack.push({array:items});continue;}
    if(char==='/') {const m=/^\/[^\s/\[\]()<>]*/.exec(content.slice(i,i+100));stack.push({name:m[0].slice(1)});i+=m[0].length;continue;}
    const m=/^[^\s/\[\]()<>]+/.exec(content.slice(i,i+100));if(!m) {i++;continue;}
    const token=m[0];i+=token.length;
    if(/^-?\d*\.?\d+$/.test(token)) {stack.push({number:Number(token)});continue;}
    if(token==='Tf') {const name=stack.at(-2)?.name;font=fonts[name] || null;}
    else if(token==='Tj' || token==="'" || token==='"') {if(token!=='Tj') out+='\n';const s=stack.findLast(item=>item.string!==undefined);if(s) out+=decode(s.string);}
    else if(token==='TJ') {for(const item of stack.at(-1)?.array || []) {if(item.string!==undefined) out+=decode(item.string);else if(item.number<-250) out+=' ';}}
    else if(token==='Td' || token==='TD') {if(Math.abs(stack.at(-1)?.number ?? 0)>0.5) out+='\n';else out+=' ';}
    else if(token==='T*' || token==='ET') out+='\n';
    else if(token==='Tm') out+='\n';
    stack.length=0;
  }
  return out;
}

function extractPdfText(buffer) {
  if(buffer.subarray(0,5).toString('latin1')!=='%PDF-') throw new ApiError('O arquivo não é um PDF válido.',422);
  if(/\/Encrypt\b/.test(buffer.subarray(Math.max(0,buffer.length-2048)).toString('latin1'))) throw new ApiError('Este PDF é protegido por senha. Salve uma cópia sem proteção.',422);
  const objects=readObjects(buffer),resolve=number=>objects.get(Number(number));
  const fontCache=new Map();
  const loadFont=number=>{
    if(fontCache.has(number)) return fontCache.get(number);
    const object=resolve(number),link=object?.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    const font=link && resolve(link[1])?.data?parseToUnicode(resolve(link[1]).data.toString('latin1')):{map:new Map(),twoByte:false};
    fontCache.set(number,font);return font;
  };
  const fontsFor=dict=>{
    const fonts={};let own=dict;
    for(let depth=0;depth<6 && own;depth++) {
      let resources=own.match(/\/Resources\s*(\d+)\s+\d+\s+R/)?(resolve(own.match(/\/Resources\s*(\d+)\s+\d+\s+R/)[1])?.dict || ''):(own.match(/\/Resources\s*<<([\s\S]*)>>/)?.[1] || '');
      let fontDict=resources.match(/\/Font\s*(\d+)\s+\d+\s+R/)?(resolve(resources.match(/\/Font\s*(\d+)\s+\d+\s+R/)[1])?.dict || ''):(resources.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] || '');
      for(const [,name,number] of fontDict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts[name]??=loadFont(Number(number));
      if(Object.keys(fonts).length) break;
      const parent=own.match(/\/Parent\s+(\d+)\s+\d+\s+R/);own=parent?resolve(parent[1])?.dict:null;
    }
    return fonts;
  };
  const pages=[...objects.entries()].filter(([,object])=>/\/Type\s*\/Page\b(?!s)/.test(object.dict)).sort((a,b)=>a[0]-b[0]);
  const order=[];
  const tree=[...objects.entries()].find(([,object])=>/\/Type\s*\/Pages\b/.test(object.dict) && !/\/Parent/.test(object.dict));
  const walk=(dict,seen=new Set())=>{
    const kids=dict.match(/\/Kids\s*\[([^\]]*)\]/)?.[1];if(!kids) return;
    for(const [,number] of kids.matchAll(/(\d+)\s+\d+\s+R/g)) {
      if(seen.has(number)) continue;seen.add(number);
      const child=resolve(number);if(!child) continue;
      if(/\/Type\s*\/Pages\b/.test(child.dict)) walk(child.dict,seen);else order.push([Number(number),child]);
    }
  };
  if(tree) walk(tree[1].dict);
  const sequence=order.length?order:pages;
  let text='';
  for(const [,page] of sequence) {
    const fonts=fontsFor(page.dict),contents=page.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/)?.[1] || '';
    const parts=[...contents.matchAll(/(\d+)\s+\d+\s+R/g)].map(item=>resolve(item[1])?.data?.toString('latin1') || '');
    text+=pageText(parts.join('\n'),fonts)+'\n\n';
  }
  return text.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
module.exports={extractPdfText};
