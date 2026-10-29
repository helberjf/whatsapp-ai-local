const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createEvolutionClient}=require('../lib/evolution.cjs');

const phone='5511998765432@s.whatsapp.net',otherPhone='5521987654321@s.whatsapp.net';
const lid='123456789012345@lid',otherLid='223456789012345@lid';
function fixture({contacts=[],chats=[],messages=[]}={}) {
  const state={contacts,chats,messages,failContacts:false,calls:[]};
  const client=createEvolutionClient({apiUrl:'http://127.0.0.1:8767',apiKey:'test-only',instanceName:'test'},async(url,options)=>{
    const route=new URL(url).pathname;
    state.calls.push({route,method:options.method,input:options.body?JSON.parse(options.body):null});
    if(route==='/chat/findContacts/test') {
      if(state.failContacts) return new Response('{}',{status:503});
      return Response.json(state.contacts);
    }
    if(route==='/chat/findChats/test') return Response.json(state.chats);
    if(route==='/chat/findMessages/test') return Response.json({messages:{records:state.messages}});
    if(route==='/message/sendSticker/test') return Response.json(state.stickerResponse || {key:{id:'sent-sticker',remoteJid:phone,fromMe:true},message:{stickerMessage:{mimetype:'image/webp'}},status:'PENDING'});
    throw new Error('Unexpected route: '+route);
  });
  return {client,state,contactCalls:()=>state.calls.filter(x=>x.route==='/chat/findContacts/test')};
}

test('saved contact name takes precedence over profile and chat names',async()=>{
  const {client}=fixture({contacts:[{remoteJid:phone,name:'  Saved name  ',pushName:'Profile name'}],chats:[{remoteJid:phone,name:'Chat name',pushName:'Recent profile'}]});
  const [chat]=await client.chats();
  assert.equal(chat.name,'Saved name');assert.equal(chat.nameSource,'saved');assert.equal(chat.phone,'5511998765432');
});

test('Evolution contact pushName replaces the chat fallback without claiming saved provenance',async()=>{
  const {client}=fixture({contacts:[{remoteJid:phone,pushName:'Connector name',isSaved:true}],chats:[{remoteJid:phone,pushName:'5511998765432'}]});
  const [chat]=await client.chats();assert.equal(chat.name,'Connector name');assert.equal(chat.nameSource,'profile');
});

test('uses an incoming message profile as the final name fallback and never the connected account name',async()=>{
  const {client}=fixture({chats:[{remoteJid:phone,lastMessage:{key:{remoteJid:phone,fromMe:false},pushName:'Incoming profile'}},{remoteJid:otherPhone,lastMessage:{key:{remoteJid:otherPhone,fromMe:true},pushName:'My own name'}},{remoteJid:lid,lastMessage:{key:{remoteJid:otherLid,fromMe:false},pushName:'Unrelated'}}]});
  const chats=await client.chats();assert.equal(chats[0].name,'Incoming profile');assert.equal(chats[0].nameSource,'profile');assert.equal(chats[1].name,'5521987654321');assert.equal(chats[2].name,lid.split('@')[0]);
});

test('explicit saved chat name precedes contact profile and verified names precede pushName',async()=>{
  const {client}=fixture({contacts:[{remoteJid:phone,verifiedName:'Verified name',pushName:'Profile'},{remoteJid:otherPhone,verifiedName:'Verified business',pushName:'Profile'}],chats:[{remoteJid:phone,name:'Saved chat',pushName:'Profile'},{remoteJid:otherPhone,pushName:'Profile'}]});
  const chats=await client.chats();assert.equal(chats[0].name,'Saved chat');assert.equal(chats[0].nameSource,'saved');assert.equal(chats[1].name,'Verified business');assert.equal(chats[1].nameSource,'profile');
});

test('numeric and blank names fall back safely and never expose a LID as a phone',async()=>{
  const lastMessage={key:{id:'last',remoteJid:phone},message:{conversation:'Hello'},messageTimestamp:1793200000};
  const {client}=fixture({contacts:[{remoteJid:phone,pushName:'+55 (11) 99876-5432'},{remoteJid:lid,name:' ',pushName:'123456789012345'}],chats:[{id:phone,pushName:' ',unreadCount:3,lastMessage},{remoteJid:lid},{remoteJid:'12345@g.us',name:'Group'}]});
  const chats=await client.chats();assert.equal(chats.length,2);
  assert.equal(chats[0].name,'5511998765432');assert.equal(chats[0].nameSource,'number');assert.equal(chats[0].phone,'5511998765432');assert.equal(chats[0].unread,3);assert.equal(chats[0].lastMessage.text,'Hello');
  assert.equal(chats[1].name,'123456789012345');assert.equal(chats[1].nameSource,'number');assert.equal(chats[1].phone,undefined);
});

test('joins LID and phone only through explicit contact aliases',async()=>{
  const matchingDigits='5511998765432@lid';
  const {client}=fixture({contacts:[{id:phone,lid,name:'Saved alias'}],chats:[{remoteJid:lid},{remoteJid:matchingDigits}]});
  const chats=await client.chats();assert.equal(chats[0].name,'Saved alias');assert.equal(chats[0].phone,'5511998765432');assert.equal(chats[1].name,'5511998765432');assert.equal(chats[1].phone,undefined);
});

test('supports the explicit Baileys phoneNumber JID on a LID contact',async()=>{
  const {client}=fixture({contacts:[{id:lid,phoneNumber:phone,name:'Saved on LID'}],chats:[{remoteJid:phone}]});
  assert.equal((await client.chats())[0].name,'Saved on LID');
});

test('uses explicit last-message remoteJidAlt mappings in either direction',async()=>{
  const {client}=fixture({contacts:[{remoteJid:phone,name:'Phone contact'},{remoteJid:otherLid,name:'LID contact'}],chats:[{remoteJid:lid,lastMessage:{key:{remoteJid:lid,remoteJidAlt:phone}}},{remoteJid:otherPhone,lastMessage:{key:{remoteJid:otherPhone,remoteJidAlt:otherLid}}}]});
  const chats=await client.chats();assert.equal(chats[0].name,'Phone contact');assert.equal(chats[0].phone,'5511998765432');assert.equal(chats[1].name,'LID contact');assert.equal(chats[1].phone,'5521987654321');
});

test('ignores ambiguous aliases and unrelated message keys',async()=>{
  const {client}=fixture({contacts:[{remoteJid:phone,lid,name:'First'},{remoteJid:otherPhone,lid,name:'Second'}],chats:[{remoteJid:lid},{remoteJid:otherLid,lastMessage:{key:{remoteJid:lid,remoteJidAlt:phone}}},{remoteJid:phone}]});
  const chats=await client.chats();assert.equal(chats[0].name,lid.split('@')[0]);assert.equal(chats[0].phone,undefined);assert.equal(chats[1].name,otherLid.split('@')[0]);assert.equal(chats[1].phone,undefined);assert.equal(chats[2].name,'First');
});

test('preserves cached names when refreshing contacts fails and throttles automatic retries',async()=>{
  const {client,state,contactCalls}=fixture({contacts:[{remoteJid:phone,name:'Remembered'}],chats:[{remoteJid:phone,pushName:'Fallback'}]});
  await client.chats();const before=await client.syncContacts();state.failContacts=true;
  const failed=await client.syncContacts(true);assert.equal(failed.total,1);assert.equal(failed.named,1);assert.equal(failed.lastSyncAt,before.lastSyncAt);assert.match(failed.error,/contatos/i);
  assert.equal((await client.chats())[0].name,'Remembered');assert.equal(contactCalls().length,2);
});

test('contact errors on first load do not block chat listing',async()=>{
  const {client,state,contactCalls}=fixture({chats:[{remoteJid:phone,pushName:'Available profile'}]});state.failContacts=true;
  assert.equal((await client.chats())[0].name,'Available profile');assert.equal((await client.chats())[0].name,'Available profile');assert.equal(contactCalls().length,1);
  const summary=await client.syncContacts();assert.equal(summary.lastSyncAt,null);assert.equal(summary.total,0);assert.match(summary.error,/contatos/i);
});

test('refreshes after five minutes and manual sync bypasses the cache',async t=>{
  let now=1793200000000;t.mock.method(Date,'now',()=>now);
  const {client,state,contactCalls}=fixture({contacts:[{remoteJid:phone,pushName:'First'}],chats:[{remoteJid:phone}]});
  await client.chats();state.contacts=[{remoteJid:phone,pushName:'Second'}];now+=299999;
  assert.equal((await client.chats())[0].name,'First');assert.equal(contactCalls().length,1);now+=1;
  assert.equal((await client.chats())[0].name,'Second');assert.equal(contactCalls().length,2);
  state.contacts=[{remoteJid:phone,pushName:'Third'}];const summary=await client.syncContacts(true);
  assert.equal(contactCalls().length,3);assert.equal((await client.chats())[0].name,'Third');assert.equal(summary.total,1);assert.equal(summary.named,1);assert.equal(summary.lastSyncAt,new Date(now).toISOString());assert.equal(summary.error,undefined);
  assert.deepEqual(contactCalls()[0].input,{});assert.equal(contactCalls()[0].method,'POST');
});

test('deduplicates concurrent refreshes and keeps each client cache isolated',async()=>{
  const {client,contactCalls}=fixture({contacts:[{remoteJid:phone,name:'One'}],chats:[{remoteJid:phone}]});
  await Promise.all([client.chats(),client.chats(),client.syncContacts(true)]);assert.equal(contactCalls().length,1);
  const other=fixture({contacts:[{remoteJid:phone,name:'Two'}],chats:[{remoteJid:phone}]});assert.equal((await other.client.chats())[0].name,'Two');assert.equal((await client.chats())[0].name,'One');
});

test('malformed refresh preserves names; a valid empty snapshot removes old names',async()=>{
  const {client,state}=fixture({contacts:[{remoteJid:phone,name:'Cached'}],chats:[{remoteJid:phone}]});await client.chats();
  state.contacts={};const failed=await client.syncContacts(true);assert.match(failed.error,/contatos/i);assert.equal((await client.chats())[0].name,'Cached');
  state.contacts=[];const empty=await client.syncContacts(true);assert.equal(empty.total,0);assert.equal(empty.error,undefined);assert.equal((await client.chats())[0].name,'5511998765432');
});

test('loads one original message with exact id and conversation matching',async()=>{
  const raw={key:{id:'original',remoteJid:phone,fromMe:false},message:{conversation:'Original text'},messageTimestamp:1793200000};
  const {client,state}=fixture({messages:[raw]});const message=await client.message(phone,'original');assert.equal(message.text,'Original text');assert.equal(message.jid,phone);
  assert.deepEqual(state.calls[0].input,{where:{key:{id:'original',remoteJid:phone}},page:1,offset:1});
});

test('single-message lookup rejects missing messages and mismatched ids or conversations',async()=>{
  const {client,state}=fixture({messages:[]});await assert.rejects(client.message(phone,'original'),{status:404});
  state.messages=[{key:{id:'other',remoteJid:phone},message:{conversation:'Wrong'}}];await assert.rejects(client.message(phone,'original'),{status:404});
  state.messages=[{key:{id:'original',remoteJid:otherPhone},message:{conversation:'Wrong'}}];await assert.rejects(client.message(phone,'original'),{status:404});
  await assert.rejects(client.message('123@g.us','original'),{status:422});await assert.rejects(client.message(phone,''),{status:422});
});

test('sends a sticker through the supported Evolution route and normalizes its response',async()=>{
  const {client,state}=fixture();const message=await client.sendSticker(phone,{base64:'c3RpY2tlcg=='});
  assert.equal(message.id,'sent-sticker');assert.equal(message.type,'sticker');assert.equal(message.fromMe,true);
  assert.deepEqual(state.calls[0],{route:'/message/sendSticker/test',method:'POST',input:{number:phone,sticker:'c3RpY2tlcg=='}});
});

test('sticker send requires a direct conversation and connector confirmation',async()=>{
  const {client,state}=fixture();await assert.rejects(client.sendSticker('123@g.us',{base64:'c3RpY2tlcg=='}),{status:422});
  state.stickerResponse={};await assert.rejects(client.sendSticker(phone,{base64:'c3RpY2tlcg=='}),{status:502});
});
