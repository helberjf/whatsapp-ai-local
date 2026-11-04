const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createEvolutionClient,normalizeMessage,vcardPhones}=require('../lib/evolution.cjs');
const {createWhatsAppServer}=require('../server.cjs');

const jid='5511998765432@s.whatsapp.net',owner='5511000000000@s.whatsapp.net';
const config={apiUrl:'http://127.0.0.1:1',apiKey:'chave',instanceName:'teste'};

// Conector Evolution de teste: registra cada chamada e responde pelo roteiro informado.
function connector(routes={}) {
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):undefined;calls.push({route,method:options.method,input});
    const handler=Object.entries(routes).find(([part])=>route.includes(part))?.[1];
    if(!handler) return new Response(JSON.stringify({error:'sem rota'}),{status:404});
    const output=typeof handler==='function'?await handler(input):handler;
    return new Response(JSON.stringify(output));
  };
  return {calls,fetchImpl};
}
const original=(id,message,fromMe=true,extra={})=>({key:{id,remoteJid:jid,fromMe},message,messageTimestamp:Math.floor(Date.now()/1000)-30,...extra});
const findMessages=records=>input=>({messages:{records:records.filter(item=>item.key.id===input.where?.key?.id || !input.where?.key?.id)}});

test('normaliza reação, localização, contato, resposta citada, edição e mensagem de voz',()=>{
  const reaction=normalizeMessage({key:{id:'r1',remoteJid:jid,fromMe:false},messageType:'reactionMessage',message:{reactionMessage:{key:{id:'m1',remoteJid:jid,fromMe:true},text:'👍'}}});
  assert.equal(reaction.type,'reaction');assert.deepEqual(reaction.reaction,{targetId:'m1',emoji:'👍'});assert.equal(reaction.canForward,false);
  const place=normalizeMessage({key:{id:'l1',remoteJid:jid,fromMe:false},message:{locationMessage:{degreesLatitude:-23.5,degreesLongitude:-46.6,name:'Loja',address:'Av. Central'}}});
  assert.equal(place.type,'location');assert.equal(place.text,'Loja');assert.deepEqual(place.location,{latitude:-23.5,longitude:-46.6,name:'Loja',address:'Av. Central',live:false});
  const card=normalizeMessage({key:{id:'c1',remoteJid:jid,fromMe:false},message:{contactMessage:{displayName:'Bia',vcard:'BEGIN:VCARD\nFN:Bia\nitem1.TEL;waid=5511988887777:+55 11 98888-7777\nEND:VCARD'}}});
  assert.equal(card.type,'contact');assert.deepEqual(card.contacts,[{name:'Bia',phones:['5511988887777']}]);
  assert.deepEqual(vcardPhones('TEL;type=CELL:+55 (21) 3333-4444\nTEL:abc'),['552133334444']);
  const quoted=normalizeMessage({key:{id:'q1',remoteJid:jid,fromMe:false},status:'EDITED',message:{extendedTextMessage:{text:'Pode ser',contextInfo:{stanzaId:'m1',participant:owner,quotedMessage:{imageMessage:{caption:'Foto do produto'}}}}}});
  assert.deepEqual(quoted.quoted,{id:'m1',type:'image',text:'Foto do produto',fromMe:true});assert.equal(quoted.edited,true);assert.equal(quoted.canEdit,undefined);
  assert.equal(normalizeMessage(original('t1',{conversation:'Oi'})).canEdit,true);
  assert.equal(normalizeMessage(original('a1',{audioMessage:{ptt:true,mimetype:'audio/ogg'}})).voice,true);
  assert.equal(normalizeMessage({key:{id:'q2',remoteJid:jid,fromMe:false},message:{extendedTextMessage:{text:'x',contextInfo:{stanzaId:'../x',quotedMessage:{conversation:'y'}}}}}).quoted,undefined);
});

test('conector: cita com a chave e o conteúdo reais, envia voz como PTT e valida localização e contato',async()=>{
  const records=[original('m1',{conversation:'Pedido 42'},false)];
  const {calls,fetchImpl}=connector({'/findMessages/':findMessages(records),'/sendText/':input=>({key:{id:'s1',remoteJid:input.number,fromMe:true},message:{conversation:input.text}}),'/sendWhatsAppAudio/':{key:{id:'v1',remoteJid:jid,fromMe:true},message:{audioMessage:{ptt:true}}},'/sendLocation/':{key:{id:'loc',remoteJid:jid,fromMe:true}},'/sendContact/':{key:{id:'card',remoteJid:jid,fromMe:true}}});
  const client=createEvolutionClient(config,fetchImpl);
  await client.sendText(jid,'Recebido',{quotedId:'m1'});
  assert.deepEqual(calls.at(-1).input.quoted,{key:{id:'m1',remoteJid:jid,fromMe:false},message:{conversation:'Pedido 42'}});
  await assert.rejects(client.sendText(jid,'x',{quotedId:'nao-existe'}),{status:404});
  const voice=await client.sendVoice(jid,{base64:Buffer.from('audio-de-teste').toString('base64'),delay:1500});
  assert.equal(voice.id,'v1');assert.deepEqual({...calls.at(-1).input,audio:'…'},{number:jid,audio:'…',encoding:true,delay:1500});
  await assert.rejects(client.sendVoice(jid,{base64:'não é base64'}),{status:422});
  await client.sendLocation(jid,{latitude:'-22.9',longitude:-43.17,name:' Centro ',address:''});
  assert.deepEqual(calls.at(-1).input,{number:jid,latitude:-22.9,longitude:-43.17,name:'Centro'});
  await assert.rejects(client.sendLocation(jid,{latitude:91,longitude:0}),{status:422});
  await client.sendContact(jid,{fullName:'Carla Souza',phone:'(11) 98888-7777',email:'carla@example.com'});
  assert.deepEqual(calls.at(-1).input,{number:jid,contact:[{fullName:'Carla Souza',wuid:'5511988887777',phoneNumber:'+5511988887777',email:'carla@example.com'}]});
  await assert.rejects(client.sendContact(jid,{fullName:'X;Y',phone:'11988887777'}),{status:422});
});

test('conector: reação, edição dentro de 15 minutos e confirmação de operações nativas',async()=>{
  const records=[original('mine',{conversation:'Olá'}),original('old',{conversation:'Antigo'},true,{messageTimestamp:Math.floor(Date.now()/1000)-3600}),original('theirs',{conversation:'Oi'},false)];
  let archived={chatId:jid,archived:true};
  const {calls,fetchImpl}=connector({'/findMessages/':findMessages(records),'/sendReaction/':{key:{id:'react-1',remoteJid:jid,fromMe:true}},'/updateMessage/':input=>({key:{id:'edit-1',remoteJid:jid,fromMe:true},message:{protocolMessage:{type:14,key:input.key}}}),'/archiveChat/':()=>archived,'/markChatUnread/':{chatId:jid,markedChatUnread:true},'/updateBlockStatus/':{block:'success'},'/fetchPrivacySettings/':{readreceipts:'all',profile:'contacts',status:'contacts',online:'all',last:'contacts',groupadd:'contacts'},'/updatePrivacySettings/':{update:'success'}});
  const client=createEvolutionClient(config,fetchImpl);
  assert.deepEqual(await client.sendReaction(jid,'theirs','❤️'),{id:'react-1',targetId:'theirs',jid,emoji:'❤️',fromMe:true});
  assert.deepEqual(calls.at(-1).input,{key:{id:'theirs',remoteJid:jid,fromMe:false},reaction:'❤️'});
  await client.sendReaction(jid,'theirs','');assert.equal(calls.at(-1).input.reaction,'');
  await assert.rejects(client.sendReaction(jid,'theirs','ok'),{status:422});
  assert.deepEqual(await client.editMessage(jid,'mine',' Olá, tudo bem? '),{id:'mine',jid,text:'Olá, tudo bem?',edited:true});
  assert.deepEqual(calls.at(-1).input,{number:jid,key:{id:'mine',remoteJid:jid,fromMe:true},text:'Olá, tudo bem?'});
  await assert.rejects(client.editMessage(jid,'theirs','x'),{status:422});
  await assert.rejects(client.editMessage(jid,'old','x'),/15 minutos/);
  assert.deepEqual(await client.archiveChat(jid,true),{jid,archived:true});assert.deepEqual(calls.at(-1).input,{chat:jid,archive:true});
  archived={archived:false};await assert.rejects(client.archiveChat(jid,true),/não confirmou/);
  assert.deepEqual(await client.markChatUnread(jid),{jid,markedUnread:true});
  assert.deepEqual(await client.blockContact(jid,true),{jid,blocked:true});assert.deepEqual(calls.at(-1).input,{number:jid,status:'block'});
  assert.deepEqual(await client.updatePrivacySettings({last:'none'}),{readreceipts:'all',profile:'contacts',status:'contacts',online:'all',last:'none',groupadd:'contacts'});
  await assert.rejects(client.updatePrivacySettings({online:'none'}),{status:422});
  await assert.rejects(client.presence(jid,'online'),{status:422});
});

async function serverFixture(t,routes,options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-features-'));
  const keys=new Map(),credentials={has:async name=>keys.has(name),get:async name=>keys.get(name) || null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);},close:async()=>{}};
  const {calls,fetchImpl}=connector(routes);
  const server=createWhatsAppServer({config,storeDir:dir,fetchImpl,credentials,disableWorkers:true,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,token=(await (await fetch(base)).text()).match(/content="([a-f0-9]{64})"/)[1];
  const call=async(route,method='GET',input)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token,Origin:base},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};};
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});});
  return {call,calls,server,dir,keys};
}

test('rotas: fixar até 3 conversas, arquivar e bloquear só após confirmação, silenciar e não lida',async t=>{
  let archive={chatId:jid,archived:true};
  const {call,calls}=await serverFixture(t,{'/archiveChat/':()=>archive,'/markChatUnread/':{markedChatUnread:true},'/updateBlockStatus/':{block:'success'}});
  const others=['5511900000001','5511900000002','5511900000003'].map(n=>n+'@s.whatsapp.net');
  for(const other of others.slice(0,3)) assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(other),'PATCH',{pinned:true})).body.pinned,true);
  const fourth=await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{pinned:true});assert.equal(fourth.status,409);assert.match(fourth.body.error,/até 3/);
  archive={archived:false};
  assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{archived:true})).status,502);
  archive={chatId:jid,archived:true};
  const archived=(await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{archived:true})).body;assert.equal(archived.archived,true);
  const muted=(await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{muteHours:8})).body;assert.ok(Date.parse(muted.mutedUntil)>Date.now());
  assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{muteHours:-1})).body.mutedUntil,'always');
  assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{muteHours:3})).status,422);
  assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{markedUnread:true})).body.markedUnread,true);
  const cleared=calls.length;assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{markedUnread:false})).body.markedUnread,false);assert.equal(calls.length,cleared,'limpar a marcação é local');
  assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{blocked:true})).body.blocked,true);
  assert.deepEqual((await call('/api/blocked')).body,[{jid}]);
  assert.equal((await call('/api/chat-state?jid='+encodeURIComponent(jid),'PATCH',{pinned:'sim'})).status,422);
  assert.equal((await call('/api/chat-state?jid=abc','PATCH',{pinned:true})).status,422);
});

test('rotas: responder, reagir, editar, favoritas e presença usam envios idempotentes e validação',async t=>{
  const records=[original('m1',{conversation:'Texto original'},false),original('mine',{conversation:'Meu texto'})];
  let sends=0;
  const {call,calls}=await serverFixture(t,{'/findMessages/':findMessages(records),'/sendText/':input=>{sends++;return {key:{id:'s'+sends,remoteJid:jid,fromMe:true},message:{conversation:input.text}};},'/sendReaction/':{key:{id:'r1',remoteJid:jid,fromMe:true}},'/updateMessage/':input=>({key:{id:'e1',remoteJid:jid,fromMe:true},message:{protocolMessage:{key:input.key}}}),'/sendPresence/':{}});
  const reply={jid,text:'Respondendo',quotedId:'m1',requestId:'pedido-resposta-1'};
  assert.equal((await call('/api/send','POST',reply)).status,200);assert.equal((await call('/api/send','POST',reply)).status,200);assert.equal(sends,1);
  assert.equal(calls.find(item=>item.route.includes('/sendText/')).input.quoted.key.id,'m1');
  assert.equal((await call('/api/send','POST',{jid,text:'x',quotedId:'../m1',requestId:'pedido-resposta-2'})).status,422);
  assert.equal((await call('/api/messages/react','POST',{jid,messageId:'m1',emoji:'🙏',requestId:'pedido-reacao-1'})).body.emoji,'🙏');
  assert.equal((await call('/api/messages/edit','POST',{jid,messageId:'mine',text:'Texto novo',requestId:'pedido-edicao-1'})).body.edited,true);
  assert.equal((await call('/api/messages/edit','POST',{jid,messageId:'mine',text:'',requestId:'pedido-edicao-2'})).status,422);
  const star=(await call('/api/starred','PUT',{jid,messageId:'m1',starred:true})).body;assert.equal(star.text,'Texto original');
  assert.equal((await call('/api/starred')).body.length,1);
  await call('/api/starred','PUT',{jid,messageId:'m1',starred:false});assert.deepEqual((await call('/api/starred')).body,[]);
  assert.equal((await call('/api/presence','POST',{jid,presence:'composing'})).status,200);assert.equal(calls.at(-1).input.presence,'composing');
  assert.equal((await call('/api/chat-preferences','PUT',{shareTyping:false})).body.shareTyping,false);
  const before=calls.length;assert.equal((await call('/api/presence','POST',{jid,presence:'composing'})).body.skipped,true);assert.equal(calls.length,before);
  assert.equal((await call('/api/presence','POST',{jid,presence:'online'})).status,422);
});

test('rotas: voz gravada vira PTT e perfil/privacidade validam antes de chamar o conector',async t=>{
  const {call,calls}=await serverFixture(t,{'/sendWhatsAppAudio/':{key:{id:'voz-1',remoteJid:jid,fromMe:true},message:{audioMessage:{ptt:true}}},'/updateProfileName/':{update:'success'},'/updateProfileStatus/':{update:'success'},'/updateProfilePicture/':{update:'success'}});
  const audio=Buffer.from('OggS gravação').toString('base64');
  assert.equal((await call('/api/send-voice','POST',{jid,base64:audio,mimeType:'audio/webm;codecs=opus',requestId:'pedido-voz-0001'})).body.voice,true);
  assert.equal((await call('/api/send-voice','POST',{jid,base64:audio,mimeType:'video/mp4',requestId:'pedido-voz-0002'})).status,422);
  assert.deepEqual((await call('/api/profile','PATCH',{name:'Loja Demo',about:'Respondo rápido'})).body,{name:'Loja Demo',about:'Respondo rápido'});
  assert.equal((await call('/api/profile','PATCH',{name:'x'.repeat(26)})).status,422);
  assert.equal((await call('/api/profile/picture','PUT',{mimeType:'image/png',base64:Buffer.from('não é png').toString('base64')})).status,422);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(20)]).toString('base64');
  assert.equal((await call('/api/profile/picture','PUT',{mimeType:'image/png',base64:png})).body.updated,true);
  assert.ok(calls.some(item=>item.route.includes('/updateProfilePicture/')));
});
