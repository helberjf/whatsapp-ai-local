// Isolated portfolio/test environment. This process never connects to WhatsApp or an AI provider.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createWhatsAppServer}=require('../server.cjs');
const {createStore}=require('../lib/store.cjs');

async function createDemo({port=8876,autoTranscription=false}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-central-demo-'));
  const names=['Alex Morgan','Sam Rivera','Taylor Chen','Jordan Lee','Casey Silva','Robin Santos','Jamie Costa','Drew Lima','Avery Rocha','Riley Alves'];
  const jids=names.map((_,i)=>`55110000000${String(i).padStart(2,'0')}@s.whatsapp.net`);
  const stamp=Math.floor(Date.now()/1000);
  const raw=(i,id,text,fromMe=false,age=0)=>({key:{id,remoteJid:jids[i],fromMe},message:{conversation:text},messageTimestamp:stamp-age,status:'READ'});
  const histories=jids.map((_,i)=>[raw(i,'hello-'+i,'Olá! Queria saber mais sobre os produtos e serviços.',false,600),raw(i,'reply-'+i,'Olá! Posso ajudar com o catálogo e os detalhes do seu projeto.',true,500),raw(i,'question-'+i,i===0?'Pode compartilhar uma demonstração?':'Qual é o prazo de entrega?',false,100+i)]);
  histories[0].push({...raw(0,'demo-audio','',false,90),message:{audioMessage:{mimetype:'audio/wav',seconds:3,ptt:true}}},raw(0,'demo-link','Conheça o catálogo: https://example.com/catalog e os detalhes em www.example.org.',true,80),{...raw(0,'demo-video','',true,70),message:{videoMessage:{caption:'Demonstração do produto · vídeo de teste',mimetype:'video/mp4',fileName:'product-demo.mp4'}}});
  histories[0]=histories[0].slice(-3);
  histories[0].push(raw(0,'demo-short','Maneiro',false,60));
  // Exemplos fictícios de recursos do WhatsApp: resposta citada, reação, localização e cartão de contato.
  const sam=histories[1],last=sam.pop();
  sam.push({...raw(1,'demo-quote','',false,450),message:{extendedTextMessage:{text:'Perfeito, pode ser na quinta?',contextInfo:{stanzaId:'reply-1',participant:jids[0],quotedMessage:{conversation:'Olá! Posso ajudar com o catálogo e os detalhes do seu projeto.'}}}}},
    {key:{id:'demo-reaction',remoteJid:jids[1],fromMe:false},messageType:'reactionMessage',message:{reactionMessage:{key:{id:'reply-1',remoteJid:jids[1],fromMe:true},text:'👍'}},messageTimestamp:stamp-440,status:'READ'},
    {...raw(1,'demo-location','',false,400),message:{locationMessage:{degreesLatitude:-23.561414,degreesLongitude:-46.655881,name:'Demo Store',address:'Fictional Avenue, 100'}}},
    {...raw(1,'demo-contact','',false,380),message:{contactMessage:{displayName:'Jamie Costa',vcard:'BEGIN:VCARD\nVERSION:3.0\nFN:Jamie Costa\nitem1.TEL;waid=551100000006:+55 11 0000-0006\nEND:VCARD'}}},last);
  // Imita a extensão local: guarda o estado de arquivada informado pelo WhatsApp (inclusive o do celular).
  const archivedRemote={};
  // Arquivada no celular antes da extensão existir: só aparece depois de "Buscar no WhatsApp" (leitura do estado do WhatsApp).
  const phoneOnlyArchived={[jids[8]]:{archived:true,updatedAt:Date.now()-3*86400_000,lastMessageAt:Date.now()-4*86400_000}};
  let archiveSnapshotAt=null;
  let privacy={readreceipts:'all',profile:'contacts',status:'contacts',online:'all',last:'contacts',groupadd:'contacts'},ownProfile={name:'Demo Operator',status:'Available for the demo'};
  histories[0].unshift({...raw(0,'demo-image','',false,110),message:{imageMessage:{mimetype:'image/png',caption:'Imagem de demonstração'}}},{...raw(0,'demo-pdf','',false,100),message:{documentMessage:{mimetype:'application/pdf',fileName:'sample.pdf'}}});
  const store=createStore(directory);
  await store.update(data=>{for(let i=0;i<jids.length;i++) data.contacts[jids[i]]={status:i===3?'closed':i===1?'pending':'open',labels:i<3?['Cliente','Interesse']:[],notes:[],crm:{stage:i===1?'negotiating':'new',notes:'Contato fictício para demonstração.',history:[]}};data.settings.templates=[{name:'Welcome',body:'Olá! Obrigado pelo contato. Como posso ajudar?'}];});
  // Equipe fictícia e números de exemplo para o painel da demo.
  const {dayKey}=require('../lib/team.cjs'),hours=Array(24).fill(0);[[8,3],[9,7],[10,11],[11,9],[12,4],[13,6],[14,10],[15,8],[16,5],[17,3]].forEach(([hour,value])=>{hours[hour]=value;});
  await store.update(data=>{data.team={settings:{members:[{id:'m-ana',name:'Ana',color:'#00a98d'},{id:'m-bruno',name:'Bruno',color:'#5b8def'}]},waiting:{},days:{[dayKey(Date.now())]:{incoming:66,hours,responses:61,responseMs:61*4.2*60_000,auto:38,human:23,onTime:55,late:6,closed:41,handoffs:5,unanswered:2,triaged:0,notices:0,surveys:{sent:30,answered:21,scores:[13,5,2,1]},members:{'m-ana':{responses:14,responseMs:14*5.1*60_000,closed:18},'m-bruno':{responses:9,responseMs:9*6.4*60_000,closed:12}}}}};data.contacts[jids[0]].assignee='m-ana';data.contacts[jids[2]].assignee='m-bruno';});
  await createStore(directory,{file:'ai.json',initial:{}}).update(data=>Object.assign(data,{provider:'ollama',model:'demo-local',embeddingModel:'demo-embed',baseUrl:'http://127.0.0.1:11434',apiKey:''}));
  // Contas adicionadas pela interface: pareiam sozinhas pouco depois do QR Code e começam sem conversas.
  const added=new Map();
  function addedInstance(url,route,input) {
    const name=route==='/instance/create'?input.instanceName:route==='/instance/fetchInstances'?new URL(url).searchParams.get('instanceName'):route.split('/').pop(),item=added.get(name);
    if(route==='/instance/create') {added.set(name,{state:'connecting',pairAt:null});return {instance:{instanceName:name}};}
    if(!item) return null;
    if(route.includes('/connectionState/')) {if(item.pairAt && Date.now()>=item.pairAt) item.state='open';return {instance:{state:item.state}};}
    if(route==='/instance/fetchInstances') return [{name,ownerJid:'5511000000099@s.whatsapp.net'}];
    if(route.startsWith('/instance/connect/')) {item.pairAt=Date.now()+1500;return {base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK9sAAAAASUVORK5CYII=',count:1};}
    if(route.startsWith('/instance/logout/')) {Object.assign(item,{state:'close',pairAt:null});return {status:'SUCCESS'};}
    if(route.startsWith('/instance/delete/')) {added.delete(name);return {status:'SUCCESS'};}
    return route.includes('/findChats/') || route.includes('/findContacts/')?[]:{};
  }
  const fetchConnector=async(url,options={})=>{
    const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};let output={};
    if(route==='/instance/create' || !(route==='/instance/fetchInstances'?new URL(url).searchParams.get('instanceName'):route.split('/').pop()).startsWith('demo')) {const reply=addedInstance(url,route,input);return reply?new Response(JSON.stringify(reply)):new Response('{}',{status:404});}
    if(route.includes('/connectionState/')) output={instance:{state:'open'}};
    else if(route.includes('/fetchInstances')) output=[{name:'demo',ownerJid:jids[0]}];
    else if(route.includes('/findContacts/')) output=[...jids.map((jid,i)=>({remoteJid:jid,name:names[i],pushName:names[i]})),{remoteJid:'5511000000020@s.whatsapp.net',pushName:'Morgan Blake'},{remoteJid:'5511000000021@s.whatsapp.net',pushName:'Quinn Park'}];
    else if(route.includes('/localArchivedSnapshot/')) {let changed=0;for(const [jid,item] of Object.entries(phoneOnlyArchived)) if(!archivedRemote[jid] || archivedRemote[jid].updatedAt<item.updatedAt) {archivedRemote[jid]=item;changed++;}archiveSnapshotAt=Date.now();output={success:true,archived:Object.values(archivedRemote).filter(item=>item.archived).length,changed,snapshotAt:archiveSnapshotAt,unarchiveChats:false};}
    else if(route.includes('/localArchived/')) output={extensionVersion:2,archiveSync:true,snapshot:true,snapshotAt:archiveSnapshotAt,unarchiveChats:false,chats:archivedRemote};
    else if(route.includes('/findChats/')) output=jids.map((jid,i)=>({remoteJid:jid,pushName:names[i],unreadCount:i===1?2:0,lastMessage:histories[i].at(-1)}));
    else if(route.includes('/findMessages/')) {const list=histories[jids.indexOf(input.where?.key?.remoteJid)] || [];output={messages:{records:input.where?.key?.id?list.filter(m=>m.key.id===input.where.key.id):list,currentPage:1,pages:1,total:list.length}};}
    else if(route.includes('/getBase64FromMediaMessage/')) {const id=input.message?.key?.id;output=id==='demo-image'?{base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK9sAAAAASUVORK5CYII=',mimetype:'image/png',fileName:'sample.png'}:id==='demo-pdf'?{base64:samplePdf().toString('base64'),mimetype:'application/pdf',fileName:'sample.pdf'}:{base64:id==='demo-video'?(await fs.readFile(path.join(__dirname,'..','tests','fixtures','demo.mp4'))).toString('base64'):wave().toString('base64'),mimetype:id==='demo-video'?'video/mp4':'audio/wav',fileName:id==='demo-video'?'demo.mp4':'demo.wav'};}
    else if(route.includes('/fetchProfile/')) output=String(input.number).includes('@')?{name:names[jids.indexOf(input.number)],status:'Fictional demo contact',picture:null}:{...ownProfile,isBusiness:false};
    else if(route.includes('/updateProfileName/')) {ownProfile.name=input.name;output={update:'success'};}
    else if(route.includes('/updateProfileStatus/')) {ownProfile.status=input.status;output={update:'success'};}
    else if(route.includes('/updateProfilePicture/') || route.includes('/removeProfilePicture/')) output={update:'success'};
    else if(route.includes('/fetchPrivacySettings/')) output=privacy;
    else if(route.includes('/updatePrivacySettings/')) {privacy={...input};output={update:'success',data:privacy};}
    else if(route.includes('/sendPresence/')) output={presence:input.presence};
    else if(route.includes('/archiveChat/')) {archivedRemote[input.chat]={archived:input.archive,updatedAt:Date.now()};output={chatId:input.chat,archived:true};}
    else if(route.includes('/markChatUnread/')) output={chatId:input.chat,markedChatUnread:true};
    else if(route.includes('/updateBlockStatus/')) output={block:'success'};
    else if(route.includes('/updateMessage/')) {const original=histories.flat().find(m=>m.key.id===input.key?.id);if(original) {if(original.message?.extendedTextMessage) original.message.extendedTextMessage.text=input.text;else original.message={conversation:input.text};original.status='EDITED';}output={key:{id:'edit-'+Date.now(),remoteJid:input.number,fromMe:true},message:{protocolMessage:{type:14,key:input.key}}};}
    else if(route.includes('/sendReaction/')) {const i=jids.indexOf(input.key?.remoteJid),sent={key:{id:'demo-react-'+Date.now(),remoteJid:input.key?.remoteJid,fromMe:true},messageType:'reactionMessage',message:{reactionMessage:{key:input.key,text:input.reaction}},messageTimestamp:Math.floor(Date.now()/1000),status:'SERVER_ACK'};if(i>=0) histories[i].push(sent);output=sent;}
    else if(route.includes('/sendViewOnce/')) {
      const i=jids.indexOf(input.number),type=input.mediatype;
      const message={viewOnceMessage:{message:{[type+'Message']:{mimetype:input.mimetype,ptt:type==='audio'}}}};
      output={...raw(Math.max(i,0),'demo-once-'+Date.now(),'',true),message};
      if(i>=0) histories[i].push(output);
    }
    else if(['/sendWhatsAppAudio/','/sendLocation/','/sendContact/'].some(part=>route.includes(part))) {
      const i=jids.indexOf(input.number),content=route.includes('Audio')?{audioMessage:{mimetype:'audio/ogg; codecs=opus',seconds:3,ptt:true}}:route.includes('Location')?{locationMessage:{degreesLatitude:input.latitude,degreesLongitude:input.longitude,name:input.name,address:input.address}}:{contactMessage:{displayName:input.contact?.[0]?.fullName,vcard:`BEGIN:VCARD\nFN:${input.contact?.[0]?.fullName}\nitem1.TEL;waid=${input.contact?.[0]?.wuid}:${input.contact?.[0]?.phoneNumber}\nEND:VCARD`}};
      const sent={...raw(Math.max(i,0),'demo-sent-'+Date.now(),'',true),message:content};if(i>=0) histories[i].push(sent);output=sent;
    }
    else if(route.includes('/fetchBusinessProfile/')) output={isBusiness:false};
    else if(route.includes('/fetchProfilePictureUrl/')) output={profilePictureUrl:null};
    else if(route.includes('/localCapabilities/')) output={extensionVersion:1,disappearingMessages:true,expiration:0};
    else if(route.includes('/updateEphemeral/')) output={jid:input.number,expiration:input.expiration,success:true,updatedAt:Date.now()};
    else if(route.includes('/deleteMessageForEveryone/')) {const original=histories.flat().find(m=>m.key.id===input.id);if(original) {original.deleted=true;original.message={protocolMessage:{type:'REVOKE',key:original.key}};}output={key:{id:'revoke-'+input.id,remoteJid:input.remoteJid,fromMe:true},message:{protocolMessage:{type:0,key:{id:input.id,remoteJid:input.remoteJid,fromMe:true}}}};}
    else if(route.startsWith('/message/')) {const i=jids.indexOf(input.number),sent=raw(i,'demo-sent-'+Date.now(),input.text || input.caption || '[Anexo de demonstração]',true);if(input.quoted) sent.message={extendedTextMessage:{text:input.text || input.caption || '',contextInfo:{stanzaId:input.quoted.key.id,participant:input.quoted.key.fromMe?jids[0]:input.quoted.key.remoteJid,quotedMessage:input.quoted.message}}};if(i>=0) histories[i].push(sent);output=sent;}
    else if(!route.includes('/markMessageAsRead/')) return new Response(JSON.stringify({error:'No external connector in demo mode'}),{status:404});
    return new Response(JSON.stringify(output));
  };
  const keys=new Map(),credentials={has:async name=>keys.has(name),get:async name=>keys.get(name)||null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);},close:async()=>{keys.clear();}};
  let localLoaded=false;const localState=input=>({installed:true,running:true,model:input.model || 'demo-local',modelInstalled:true,loaded:localLoaded,executionMode:input.device==='cpu'?'cpu':'gpu',models:['demo-local'],starting:false}),localAi={status:async input=>localState(input),start:async input=>{localLoaded=true;return localState(input);}};
  const aiCalls=[];
  // Voz fictícia: um tom curto no lugar da fala, sem Windows nem OpenAI.
  const speech={windowsAvailable:true,voices:async()=>[{name:'Demo Voice',culture:'pt-BR',gender:'Female'}],synthesize:async()=>({base64:wave().toString('base64'),mimeType:'audio/wav',bytes:96044,provider:'windows'})};
  const server=createWhatsAppServer({demo:true,autoTranscription,transcriptionEngines:{whisperEngine:async()=>({text:"Transcrição automática de demonstração"})},storeDir:directory,credentials,localAi,speech,disableWorkers:true,config:{apiUrl:'http://127.0.0.1:9999',apiKey:'demo-only',instanceName:'demo'},fetchImpl:fetchConnector,aiFetch:async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.endsWith('/api/embed')) return new Response(JSON.stringify({embeddings:body.input.map(demoVector)}));
    aiCalls.push(body);
    if(body.format==='json' && body.messages?.[0]?.content?.includes('perguntas frequentes')) return new Response(JSON.stringify({message:{content:JSON.stringify({suggestions:DEMO_SUGGESTIONS})}}));
    return new Response(JSON.stringify({message:{content:'Posso ajudar com o produto Studio Headphones. O prazo demonstrativo é de 2 a 4 dias úteis.'}}));}});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,html=await(await fetch(base)).text(),token=html.match(/name="whatsapp-session" content="([a-f0-9]+)"/)[1];
  const api=async(route,input)=>{const response=await fetch(base+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},body:JSON.stringify(input)});if(!response.ok) throw Error('Demo fixture failed: '+route);return response.json();};
  await api('/kb',{name:'Product guide.txt',text:'Studio Headphones: comfortable wireless headphones with 24-hour battery life. Price BRL 249.90. Delivery in 2 to 4 business days. Warranty: 12 months. Web Design: responsive personal websites, quoted individually.'});
  await api('/products',{name:'Studio Headphones',kind:'produto',category:'Audio',description:'Wireless headphones with 24-hour battery life and comfortable ear cushions.',price:249.90,stock:18,active:true,warranty:'12 months',sku:'DEMO-001'});
  await api('/products',{name:'Web Design',kind:'servico',category:'Services',description:'Responsive websites tailored to your project.',price:null,stock:null,active:true,sku:'DEMO-002'});
  await server.team.tick();
  return {server,base,directory,aiCalls,archiveOnPhone(index,archived=true) {archivedRemote[jids[index]]={archived,updatedAt:Date.now()};server.invalidateChats();},async close(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await Promise.all([server.scheduler.idle(),server.triggers.idle(),server.assistant.idle()]);if(path.dirname(directory)!==os.tmpdir() || !path.basename(directory).startsWith('whatsapp-central-demo-')) throw Error('Unsafe demo cleanup path');await fs.rm(directory,{recursive:true,force:true});}};
}
// Embeddings fictícios: cada posição conta menções de um assunto, então "fone sem fio" encontra "headphones" sem palavras em comum.
const DEMO_CONCEPTS=[/headphone|fone|audio|som|musica|battery|bateria/g,/delivery|entrega|prazo|frete|envio/g,/warranty|garantia|defeito/g,/website|site|web|design|pagina/g,/price|preco|valor|custa|brl|reais/g];
const demoVector=text=>{const clean=String(text).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();return [...DEMO_CONCEPTS.map(pattern=>(clean.match(pattern) || []).length),.05];};
const DEMO_SUGGESTIONS=[{question:'O fone tem garantia?',keywords:['garantia','defeito'],answer:'Sim! O Studio Headphones tem garantia de 12 meses.'},{question:'Qual é o prazo de entrega?',keywords:['prazo','entrega'],answer:'A entrega leva de 2 a 4 dias úteis.'}];
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
