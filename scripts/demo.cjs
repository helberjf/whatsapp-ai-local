// Isolated portfolio/test environment. This process never connects to WhatsApp or an AI provider.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createWhatsAppServer}=require('../server.cjs');
const {createStore}=require('../lib/store.cjs');

async function createDemo({port=8876}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-central-demo-'));
  const names=['Alex Morgan','Sam Rivera','Taylor Chen','Jordan Lee','Casey Silva','Robin Santos','Jamie Costa','Drew Lima','Avery Rocha','Riley Alves'];
  const jids=names.map((_,i)=>`55110000000${String(i).padStart(2,'0')}@s.whatsapp.net`);
  const stamp=Math.floor(Date.now()/1000);
  const raw=(i,id,text,fromMe=false,age=0)=>({key:{id,remoteJid:jids[i],fromMe},message:{conversation:text},messageTimestamp:stamp-age,status:'READ'});
  const histories=jids.map((_,i)=>[raw(i,'hello-'+i,'Olá! Queria saber mais sobre os produtos e serviços.',false,600),raw(i,'reply-'+i,'Olá! Posso ajudar com o catálogo e os detalhes do seu projeto.',true,500),raw(i,'question-'+i,i===0?'Pode compartilhar uma demonstração?':'Qual é o prazo de entrega?',false,100+i)]);
  histories[0].push({...raw(0,'demo-audio','',false,90),message:{audioMessage:{mimetype:'audio/wav',seconds:3,ptt:true}}},raw(0,'demo-link','Conheça o catálogo: https://example.com/catalog e os detalhes em www.example.org.',true,80),{...raw(0,'demo-video','',true,70),message:{videoMessage:{caption:'Demonstração do produto · vídeo de teste',mimetype:'video/mp4',fileName:'product-demo.mp4'}}});
  histories[0]=histories[0].slice(-3);
  histories[0].push(raw(0,'demo-short','Maneiro',false,60));
  histories[0].unshift({...raw(0,'demo-image','',false,110),message:{imageMessage:{mimetype:'image/png',caption:'Imagem de demonstração'}}},{...raw(0,'demo-pdf','',false,100),message:{documentMessage:{mimetype:'application/pdf',fileName:'sample.pdf'}}});
  const store=createStore(directory);
  await store.update(data=>{for(let i=0;i<jids.length;i++) data.contacts[jids[i]]={status:i===3?'closed':i===1?'pending':'open',labels:i<3?['Cliente','Interesse']:[],notes:[],crm:{stage:i===1?'negotiating':'new',notes:'Contato fictício para demonstração.',history:[]}};data.settings.templates=[{name:'Welcome',body:'Olá! Obrigado pelo contato. Como posso ajudar?'}];});
  await createStore(directory,{file:'ai.json',initial:{}}).update(data=>Object.assign(data,{provider:'ollama',model:'demo-local',baseUrl:'http://127.0.0.1:11434',apiKey:''}));
  const fetchConnector=async(url,options={})=>{
    const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};let output={};
    if(route.includes('/connectionState/')) output={instance:{state:'open'}};
    else if(route.includes('/fetchInstances')) output=[{name:'demo',ownerJid:jids[0]}];
    else if(route.includes('/findContacts/')) output=jids.map((jid,i)=>({remoteJid:jid,name:names[i],pushName:names[i]}));
    else if(route.includes('/findChats/')) output=jids.map((jid,i)=>({remoteJid:jid,pushName:names[i],unreadCount:i===1?2:0,lastMessage:histories[i].at(-1)}));
    else if(route.includes('/findMessages/')) {const list=histories[jids.indexOf(input.where?.key?.remoteJid)] || [];output={messages:{records:input.where?.key?.id?list.filter(m=>m.key.id===input.where.key.id):list,currentPage:1,pages:1,total:list.length}};}
    else if(route.includes('/getBase64FromMediaMessage/')) {const id=input.message?.key?.id;output=id==='demo-image'?{base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK9sAAAAASUVORK5CYII=',mimetype:'image/png',fileName:'sample.png'}:id==='demo-pdf'?{base64:samplePdf().toString('base64'),mimetype:'application/pdf',fileName:'sample.pdf'}:{base64:id==='demo-video'?(await fs.readFile(path.join(__dirname,'..','tests','fixtures','demo.mp4'))).toString('base64'):wave().toString('base64'),mimetype:id==='demo-video'?'video/mp4':'audio/wav',fileName:id==='demo-video'?'demo.mp4':'demo.wav'};}
    else if(route.includes('/fetchProfile/')) output={name:names[jids.indexOf(input.number)],status:'Fictional demo contact',picture:null};
    else if(route.includes('/fetchBusinessProfile/')) output={isBusiness:false};
    else if(route.includes('/fetchProfilePictureUrl/')) output={profilePictureUrl:null};
    else if(route.includes('/localCapabilities/')) output={extensionVersion:1,disappearingMessages:true,expiration:0};
    else if(route.includes('/updateEphemeral/')) output={jid:input.number,expiration:input.expiration,success:true,updatedAt:Date.now()};
    else if(route.includes('/deleteMessageForEveryone/')) {const original=histories.flat().find(m=>m.key.id===input.id);if(original) {original.deleted=true;original.message={protocolMessage:{type:'REVOKE',key:original.key}};}output={key:{id:'revoke-'+input.id,remoteJid:input.remoteJid,fromMe:true},message:{protocolMessage:{type:0,key:{id:input.id,remoteJid:input.remoteJid,fromMe:true}}}};}
    else if(route.startsWith('/message/')) {const i=jids.indexOf(input.number),sent=raw(i,'demo-sent-'+Date.now(),input.text || input.caption || '[Anexo de demonstração]',true);if(i>=0) histories[i].push(sent);output=sent;}
    else if(!route.includes('/markMessageAsRead/')) return new Response(JSON.stringify({error:'No external connector in demo mode'}),{status:404});
    return new Response(JSON.stringify(output));
  };
  const keys=new Map(),credentials={has:async name=>keys.has(name),get:async name=>keys.get(name)||null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);},close:async()=>{keys.clear();}};
  let localLoaded=false;const localState=input=>({installed:true,running:true,model:input.model || 'demo-local',modelInstalled:true,loaded:localLoaded,executionMode:input.device==='cpu'?'cpu':'gpu',models:['demo-local'],starting:false}),localAi={status:async input=>localState(input),start:async input=>{localLoaded=true;return localState(input);}};
  const aiCalls=[];
  const server=createWhatsAppServer({demo:true,storeDir:directory,credentials,localAi,disableWorkers:true,config:{apiUrl:'http://127.0.0.1:9999',apiKey:'demo-only',instanceName:'demo'},fetchImpl:fetchConnector,aiFetch:async(url,options)=>{aiCalls.push(JSON.parse(options.body));return new Response(JSON.stringify({message:{content:'Posso ajudar com o produto Studio Headphones. O prazo demonstrativo é de 2 a 4 dias úteis.'}}));}});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,html=await(await fetch(base)).text(),token=html.match(/name="whatsapp-session" content="([a-f0-9]+)"/)[1];
  const api=async(route,input)=>{const response=await fetch(base+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},body:JSON.stringify(input)});if(!response.ok) throw Error('Demo fixture failed: '+route);return response.json();};
  await api('/kb',{name:'Product guide.txt',text:'Studio Headphones: comfortable wireless headphones with 24-hour battery life. Price BRL 249.90. Delivery in 2 to 4 business days. Warranty: 12 months. Web Design: responsive personal websites, quoted individually.'});
  await api('/products',{name:'Studio Headphones',kind:'produto',category:'Audio',description:'Wireless headphones with 24-hour battery life and comfortable ear cushions.',price:249.90,stock:18,active:true,warranty:'12 months',sku:'DEMO-001'});
  await api('/products',{name:'Web Design',kind:'servico',category:'Services',description:'Responsive websites tailored to your project.',price:null,stock:null,active:true,sku:'DEMO-002'});
  return {server,base,directory,aiCalls,async close(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await Promise.all([server.scheduler.idle(),server.triggers.idle(),server.assistant.idle()]);if(path.dirname(directory)!==os.tmpdir() || !path.basename(directory).startsWith('whatsapp-central-demo-')) throw Error('Unsafe demo cleanup path');await fs.rm(directory,{recursive:true,force:true});}};
}
function wave() {
  const rate=16000,samples=rate*3,buffer=Buffer.alloc(44+samples*2);
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) buffer.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/rate)*1000),44+i*2);return buffer;
}
function samplePdf() {
  const stream='BT /F1 22 Tf 40 170 Td (Whats AI - Sample document) Tj ET',second='BT /F1 22 Tf 40 170 Td (Second sample page) Tj ET',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',`<< /Length ${second.length} >>\nstream\n${second}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(pdf);
}
if(require.main===module) createDemo({port:Number(process.env.WHATSAPP_DEMO_PORT)||8876}).then(demo=>{console.log('Privacy-safe demo: '+demo.base);for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>demo.close().then(()=>process.exit(0)));}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={createDemo,wave};
