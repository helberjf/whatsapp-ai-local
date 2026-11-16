// Ambiente isolado de avaliação: usa o código real do app (APP_ROOT) com uma pasta de dados temporária.
// Não toca na central em uso nem no banco de produção; só compartilha o Ollama local (bge-m3 e qwen2.5:7b).
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.removeAllListeners('warning');process.on('warning',warning=>{if(warning.name!=='ExperimentalWarning') console.warn(warning.message);});

const APP_ROOT=process.env.APP_ROOT || path.join(__dirname,'..','..');
const app=name=>require(path.join(APP_ROOT,name));
const {createKnowledgeRoutes}=app('lib/knowledge-routes.cjs');
const {createAssistantService}=app('lib/assistant.cjs');
const {createStore}=app('lib/store.cjs');
const knowledge=app('lib/knowledge.cjs');
const core=app('lib/assistant-core.cjs');
const snapshot=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'corpus','prod-snapshot.json'),'utf8'));
const normalize=text=>knowledge.normalize(String(text)).replace(/\s+/g,' ');
const memoryCredentials=()=>{const keys=new Map();return {has:async name=>keys.has(name),get:async name=>keys.get(name)||null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);},close:async()=>{}};};

// Instância com a mesma configuração de IA da produção (lida do snapshot).
async function createInstance({documents,products=[],folder,ai}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rag-audit-')),handle=createKnowledgeRoutes(directory,globalThis.fetch,{credentials:memoryCredentials(),...(folder?{knowledgeDir:folder}:{})}),{services}=handle;
  const call=async(method,route,input,context)=>{const url=new URL('http://local'+route),result=await handle({method},url.pathname,url,async()=>input,context);if(!result) throw new Error('rota não tratada: '+route);return result.body;};
  await call('PUT','/api/ai',{provider:ai.provider,model:ai.model,baseUrl:ai.baseUrl,embeddingModel:ai.embeddingModel || '',...(ai.ollamaNumGpu===0?{ollamaNumGpu:0}:{})});
  for(const doc of documents || []) await call('POST','/api/kb',doc.base64?{name:doc.name,base64:doc.base64}:{name:doc.name,text:doc.text});
  for(const product of products) await call('POST','/api/products',product);
  const index=async()=>{services.embeddings.refresh({force:true});await services.embeddings.idle();const status=await services.embeddings.status();if(status.indexed!==status.total || status.mode!=='hybrid') throw new Error('índice incompleto: '+JSON.stringify(status));return status;};
  const started=Date.now(),status=await index();
  return {directory,call,services,status,index,indexMs:Date.now()-started,
    async chunks() {const docs=await services.loadTexts();return docs.flatMap(doc=>knowledge.chunkText(doc.text).map((text,index)=>({docId:doc.id,docName:doc.name,index,text})));},
    async close() {await services.embeddings.close();await services.ai.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

// Um trecho é relevante se vier do documento certo e contiver o texto do gabarito.
const hit=(chunk,alt)=>chunk.docName.startsWith(alt.doc) && normalize(chunk.text).includes(normalize(alt.must));
// gold = lista de grupos (todos precisam aparecer); cada grupo = alternativas (basta uma).
function score(results,gold,k) {
  const top=results.slice(0,k),found=gold.map(group=>top.findIndex(chunk=>group.some(alt=>hit(chunk,alt))));
  const ranks=found.filter(rank=>rank>=0),first=ranks.length?Math.min(...ranks):-1;
  return {recall:ranks.length/gold.length,all:ranks.length===gold.length,rr:first<0?0:1/(first+1)};
}

// Busca só semântica (ablação): mesmos vetores e a mesma normalização do app, sem BM25 nem corte.
async function semanticIndex(instance) {
  const chunks=await instance.chunks(),unit=vector=>{const length=Math.hypot(...vector) || 1;return vector.map(value=>value/length);},vectors=[];
  for(let start=0;start<chunks.length;start+=32) vectors.push(...(await instance.services.ai.embed(chunks.slice(start,start+32).map(chunk=>chunk.text))).vectors.map(unit));
  return async query=>{const [wanted]=(await instance.services.ai.embed([query],{task:'query'})).vectors.map(unit);return chunks.map((chunk,row)=>({...chunk,similarity:vectors[row].reduce((sum,value,column)=>sum+value*wanted[column],0)})).sort((a,b)=>b.similarity-a.similarity);};
}

// Caminho real das respostas automáticas: conversa falsa, serviço verdadeiro, contato em modo rascunho.
async function assistantReply(instance,{history,rules,settings={source:'base',tone:'natural',history:14},otherContacts=[]}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rag-audit-chat-')),store=createStore(directory),jid='5511900000001@s.whatsapp.net',clock={t:Date.now()},trace={queries:[],prompts:[]};
  const stamp=(list,target)=>list.map((message,index)=>({id:target.slice(0,13)+'-m'+index,jid:target,fromMe:message.from==='atendente',type:'text',text:message.text,timestamp:clock.t+1000*(index+1),key:{id:target.slice(0,13)+'-m'+index,remoteJid:target,fromMe:message.from==='atendente'}}));
  const threads=new Map([[jid,stamp(history,jid)],...otherContacts.map(contact=>[contact.jid,stamp(contact.history,contact.jid)])]);
  await store.update(data=>{data.contacts[jid]={status:'open',labels:[],notes:[],aiMode:'draft',aiSince:new Date(clock.t-60_000).toISOString()};data.assistant={...settings,rules};});
  const client={chats:async()=>[{jid,name:'Cliente',lastMessage:threads.get(jid).at(-1)}],messages:async target=>({messages:threads.get(target) || []}),sendText:async()=>{throw new Error('o avaliador nunca envia mensagens');}};
  const ai={...instance.services.ai,config:()=>instance.services.ai.config(),complete:async options=>{const started=Date.now(),text=await instance.services.ai.complete(options);trace.prompts.push({system:options.system,messages:options.messages,ms:Date.now()-started,raw:text});return text;}};
  const retrieve=async(query,limit)=>{const started=Date.now(),results=await instance.services.retrieve(query,limit);trace.queries.push({query,ms:Date.now()-started,results});return results;};
  const service=createAssistantService({store,client,ai,retrieve,reliability:instance.services.reliability,catalogText:instance.services.catalogText,now:()=>clock.t});
  clock.t+=1000*(history.length+2);
  try {
    await service.tick();
    const data=await store.read(),contact=data.contacts[jid],log=(data.assistant.log || [])[0];
    return {answer:contact.aiDraft?.text || null,handoff:log?.action==='handoff',action:log?.action || null,detail:log?.detail || null,...trace};
  } finally {service.stop();await service.idle?.();fs.rmSync(directory,{recursive:true,force:true});}
}

// Critérios registrados antes da execução: must (todos), any (mínimo), forbid (nenhum), abstain (encaminhar ou dizer que não sabe).
const ABSTAIN=/atendente|nao (tenho|encontrei|possuo|sei|consigo|temos|dispomos|ha) |nao (esta|consta)|sem essa informacao|vou (consultar|verificar|confirmar)|confirmar com/;
function grade(test,answer,handoff) {
  const text=normalize(answer || ''),reasons=[];
  if(test.abstain) {if(!(handoff || ABSTAIN.test(text))) reasons.push('não se absteve');}
  else if(handoff) reasons.push('encaminhou ao atendente uma pergunta que a base responde');
  for(const pattern of test.must || []) if(!new RegExp(pattern,'i').test(text)) reasons.push('faltou: '+pattern);
  if(test.any) {const count=test.any.of.filter(pattern=>new RegExp(pattern,'i').test(text)).length;if(count<test.any.min) reasons.push(`só ${count} de ${test.any.min} itens esperados`);}
  for(const pattern of test.forbid || []) if(new RegExp(pattern,'i').test(text)) reasons.push('proibido: '+pattern);
  return {pass:!reasons.length,reasons};
}
// Números e valores na resposta que não aparecem no contexto enviado à IA nem na pergunta.
function unsupportedNumbers(answer,context) {
  const seen=normalize(context).replace(/[.\s]/g,'');
  return [...new Set((normalize(answer || '').match(/r\$ ?\d[\d.,]*|\d+[\d.,]*\s?(%|dias?|horas?|meses|mes|anos?|semanas?|x\b)/g) || []).filter(item=>!seen.includes(item.replace(/[.\s]/g,''))))];
}
const percentile=(values,p)=>{if(!values.length) return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(p/100*sorted.length)-1)];};
module.exports={APP_ROOT,app,knowledge,core,snapshot,normalize,createInstance,hit,score,semanticIndex,assistantReply,grade,unsupportedNumbers,percentile};
