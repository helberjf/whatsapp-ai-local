const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../server.cjs');

// Depois de parear de novo, o WhatsApp entrega o histórico pelo número de telefone, enquanto as mensagens antigas
// da mesma pessoa estão no identificador privado (@lid). A central mostra uma conversa só, com as mensagens das duas.
const lid='123456789012345@lid',phone='5511900000001@s.whatsapp.net';
const OLD=1793200000,NEW=1793300000;
const record=(id,jid,text,at,extra={})=>({key:{id,remoteJid:jid,fromMe:false,...extra},message:{conversation:text},messageTimestamp:at,pushName:'Ana'});
const history={[lid]:[record('antiga',lid,'Mensagem de antes',OLD,{remoteJidAlt:phone})],[phone]:[record('nova',phone,'Mensagem depois do novo pareamento',NEW)]};

async function serverWith(t,{contacts={}}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-alias-'));
  await fs.writeFile(path.join(dir,'atendimento.json'),JSON.stringify({contacts,requests:{},settings:{templates:[]}}));
  const calls=[];
  const routes={
    '/findChats/':()=>[{remoteJid:lid,unreadCount:1,lastMessage:history[lid][0]},{remoteJid:phone,unreadCount:2,lastMessage:history[phone][0]}],
    '/findContacts/':()=>[],
    '/findMessages/':input=>{
      const {id,remoteJid}=input.where.key,rows=(history[remoteJid] || []).filter(item=>!id || item.key.id===id);
      return {messages:{total:rows.length,pages:1,currentPage:input.page || 1,records:rows}};
    },
    '/sendReaction/':input=>({key:{id:'reacao',remoteJid:input.key.remoteJid,fromMe:true},message:{reactionMessage:{text:input.reaction}}}),
    '/connectionState/':()=>({instance:{state:'open'}})
  };
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};calls.push({route,input});
    const handler=Object.entries(routes).find(([part])=>route.includes(part))?.[1];
    return handler?new Response(JSON.stringify(handler(input))):new Response('{}',{status:404});
  };
  const credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:1',apiKey:'x',instanceName:'t'},storeDir:dir,fetchImpl,credentials,disableWorkers:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};};
  return {call,calls};
}

test('@lid e número da mesma pessoa viram uma conversa, com a mensagem mais nova e os dados do atendimento',async t=>{
  const {call}=await serverWith(t,{contacts:{[lid]:{status:'pending',labels:['VIP'],notes:[{id:'n',text:'Cliente antigo',at:'2026-11-01T00:00:00.000Z'}]}}});
  const chats=(await call('/api/chats')).body;
  assert.equal(chats.length,1,'uma conversa só');
  const [chat]=chats;
  assert.equal(chat.jid,lid,'fica o identificador que já tem notas e etiquetas');assert.deepEqual(chat.aliasJids,[phone]);
  assert.equal(chat.lastMessage.id,'nova');assert.equal(chat.lastMessage.timestamp,NEW*1000);
  assert.equal(chat.unread,3);assert.deepEqual(chat.labels,['VIP']);assert.equal(chat.status,'pending');assert.equal(chat.phone,'5511900000001');
  const delta=(await call('/api/chats?delta=1')).body;assert.equal(delta.chats.length,1);
});

test('abrir a conversa traz as mensagens dos dois identificadores, e as ações acham a mensagem gravada pelo outro',async t=>{
  const {call,calls}=await serverWith(t,{contacts:{[lid]:{status:'open',labels:[],notes:[]}}});
  await call('/api/chats');
  const result=(await call('/api/messages?jid='+encodeURIComponent(lid))).body;
  assert.deepEqual(result.messages.map(message=>message.id),['antiga','nova'],'em ordem, das duas origens');
  const reacted=await call('/api/messages/react','POST',{jid:lid,messageId:'nova',emoji:'👍',requestId:'reacao-alias-001'});
  assert.equal(reacted.status,200,JSON.stringify(reacted.body));
  assert.equal(calls.findLast(item=>item.route.includes('/sendReaction/')).input.key.remoteJid,phone,'a reação vai para a mensagem como ela foi gravada');
});

test('sem dados do atendimento em nenhum dos dois, fica o @lid; com dados só no número, fica o número',async t=>{
  const first=await serverWith(t);
  assert.equal((await first.call('/api/chats')).body[0].jid,lid);
  const second=await serverWith(t,{contacts:{[phone]:{status:'closed',labels:['Nova'],notes:[]}}});
  const [chat]=(await second.call('/api/chats')).body;
  assert.equal(chat.jid,phone);assert.deepEqual(chat.aliasJids,[lid]);assert.equal(chat.status,'closed');assert.equal(chat.lastMessage.id,'nova');
});

test('o estado de arquivamento mais recente vale para os dois identificadores da conversa',async t=>{
  const {call}=await serverWith(t,{contacts:{
    [lid]:{status:'pending',labels:['VIP'],archived:false,archivedAt:'2026-10-29T00:00:00Z'},
    [phone]:{archived:true,archivedAt:'2026-10-30T00:00:00Z'}
  }});
  const {body:chats}=await call('/api/chats');
  assert.equal(chats.length,1);
  assert.equal(chats[0].jid,lid);
  assert.equal(chats[0].archived,true);
  assert.deepEqual(chats[0].labels,['VIP']);
});
