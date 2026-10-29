const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createEvolutionClient,ApiError,normalizeMessage}=require('../lib/evolution.cjs');
const jid='5511998765432@s.whatsapp.net',other='5521987654321@s.whatsapp.net',lid='123456789012345@lid';
const key={id:'original',remoteJid:jid,fromMe:true};
function fixture(overrides={}) {
  const state={contacts:[],messages:[{key,message:{conversation:'Original'},messageTimestamp:1793200000}],profile:{wuid:jid,name:'Profile',status:'About'},business:{isBusiness:false},capabilities:{extensionVersion:0,disappearingMessages:false},timerResponse:{success:true,jid,expiration:86400,updatedAt:1793200000000,source:'central'},deleteResponse:{key:{id:'revoke',remoteJid:jid,fromMe:true},message:{protocolMessage:{type:0,key}}},pollResponse:{key:{id:'poll',remoteJid:jid,fromMe:true},message:{pollCreationMessageV3:{name:'Where?',options:[{optionName:'Here'},{optionName:'There'}],selectableOptionsCount:1}}},...overrides,calls:[]};
  const client=createEvolutionClient({apiUrl:'http://127.0.0.1:8767',apiKey:'test-secret-never-return',instanceName:'test'},async(url,options)=>{
    const path=new URL(url).pathname;state.calls.push({path,method:options.method,input:options.body?JSON.parse(options.body):null});
    if(state.fail?.includes(path)) return new Response('private upstream diagnostic',{status:500});
    const response=path==='/chat/findContacts/test'?state.contacts:path==='/chat/findMessages/test'?{messages:{records:state.messages}}:path==='/chat/fetchProfile/test'?state.profile:path==='/chat/fetchBusinessProfile/test'?state.business:path==='/chat/localCapabilities/test'?state.capabilities:path==='/chat/updateEphemeral/test'?state.timerResponse:path==='/chat/deleteMessageForEveryone/test'?state.deleteResponse:path==='/message/sendPoll/test'?state.pollResponse:undefined;
    if(response===undefined) throw new Error('Unexpected route: '+path);
    return Response.json(response);
  });
  return {client,state};
}
test('delete fetches the original and sends its verified flat key to Evolution',async()=>{
  const {client,state}=fixture();const result=await client.deleteMessage(jid,'original');
  assert.deepEqual(state.calls.map(c=>({path:c.path,method:c.method})),[{path:'/chat/findMessages/test',method:'POST'},{path:'/chat/deleteMessageForEveryone/test',method:'DELETE'}]);
  assert.deepEqual(state.calls[1].input,key);assert.deepEqual(result,{id:'original',jid,deleted:true,scope:'everyone'});
  const original=await client.message(jid,'original');assert.equal(original.deleted,true);assert.equal(original.text,'Mensagem apagada');assert.equal(original.canForward,false);
});
test('delete rejects received, missing, unrelated, and already deleted messages without mutation',async()=>{
  for(const message of [null,{key:{...key,fromMe:false},message:{conversation:'Incoming'}},{key:{...key,remoteJid:other},message:{conversation:'Wrong chat'}},{key:{...key,deleted:true},message:{conversation:'Secret'},status:'DELETED'}]) {
    const {client,state}=fixture({messages:message?[message]:[]});
    await assert.rejects(client.deleteMessage(jid,'original'),error=>error instanceof ApiError && [404,422].includes(error.status));
    assert.equal(state.calls.filter(c=>c.method==='DELETE').length,0);
  }
});
test('delete does not claim success or hide content without matching revoke acknowledgement',async()=>{
  for(const deleteResponse of [{},{key:{id:'revoke'},message:{protocolMessage:{type:0,key:{...key,id:'other'}}}},{key:{id:'revoke'},message:{protocolMessage:{type:0,key:{...key,remoteJid:other}}}}]) {
    const {client}=fixture({deleteResponse});await assert.rejects(client.deleteMessage(jid,'original'),{status:502});
    assert.equal((await client.message(jid,'original')).text,'Original');
  }
});
test('delete validates conversation and message identifiers before calling connector',async()=>{
  const {client,state}=fixture();
  for(const [chat,id] of [['123@g.us','original'],[jid,''],[jid,'../secret'],[jid,'x'.repeat(201)]]) await assert.rejects(client.deleteMessage(chat,id),{status:422});
  assert.equal(state.calls.length,0);
});
test('deleted metadata suppresses original text and media in normalized messages',()=>{
  for(const deletion of [{status:'DELETED'},{key:{...key,deleted:true}},{MessageUpdate:[{status:'DELETED'},{status:'READ'}]}]) {
    const message=normalizeMessage({key,message:{imageMessage:{mimetype:'image/jpeg',caption:'Private'}},...deletion});
    assert.equal(message.deleted,true);assert.equal(message.type,'deleted');assert.equal(message.text,'Mensagem apagada');assert.equal(message.mimeType,null);assert.equal(message.canForward,false);assert.equal(message.canDelete,false);
  }
});
test('revoke messages normalize the original identity and cannot revoke a different chat',()=>{
  const message=normalizeMessage({key:{id:'event',remoteJid:jid,fromMe:false},message:{protocolMessage:{type:0,key}}});
  assert.equal(message.id,'original');assert.equal(message.deleted,true);assert.equal(message.fromMe,true);
  const unrelated=normalizeMessage({key:{id:'event',remoteJid:jid},message:{protocolMessage:{type:0,key:{...key,remoteJid:other}}}});assert.notEqual(unrelated.id,'original');
});
test('message list folds revoke events over originals and keeps a tombstone on later polls',async()=>{
  const {client,state}=fixture();state.messages.push({key:{id:'event',remoteJid:jid},message:{protocolMessage:{type:0,key}}});
  const first=await client.messages(jid);assert.equal(first.messages.length,1);assert.equal(first.messages[0].deleted,true);
  state.messages.pop();assert.equal((await client.messages(jid)).messages[0].deleted,true);
});
test('ephemeral metadata is retained without pretending ordinary messages disappear',()=>{
  const message=normalizeMessage({key,message:{ephemeralMessage:{message:{extendedTextMessage:{text:'Temporary',contextInfo:{expiration:86400}}}}}});
  assert.equal(message.ephemeral,true);assert.equal(message.ephemeralExpiration,86400);assert.equal(message.text,'Temporary');
  assert.equal(normalizeMessage({key,message:{conversation:'Ordinary'}}).ephemeral,undefined);
});
test('sends a trimmed native poll using the supported Evolution contract',async()=>{
  const {client,state}=fixture();const message=await client.sendPoll(jid,{name:' Where? ',values:[' Here ',' There ']});
  assert.deepEqual(state.calls[0],{path:'/message/sendPoll/test',method:'POST',input:{number:jid,name:'Where?',values:['Here','There'],selectableCount:1}});
  assert.equal(message.type,'poll');assert.equal(message.text,'Where?');assert.deepEqual(message.poll,{name:'Where?',options:['Here','There'],selectableCount:1});assert.equal(message.canForward,false);
});
test('poll rejects malformed, repeated, empty, oversized, or inconsistent choices',async()=>{
  const {client,state}=fixture();
  for(const input of [null,{}, {name:'?',values:['one']},{name:'?',values:['one','one ']},{name:'?',values:['one',' ']},{name:'?',values:['one','two'],selectableCount:3},{name:'?',values:['one','two'],selectableCount:-1},{name:'?',values:['one','two'],selectableCount:'1'},{name:'x'.repeat(301),values:['one','two']},{name:'?',values:Array.from({length:11},(_,i)=>String(i))}]) await assert.rejects(client.sendPoll(jid,input),{status:422});
  assert.equal(state.calls.length,0);
});
test('poll selectableCount zero is preserved and failed sends never imply success',async()=>{
  const {client,state}=fixture();await client.sendPoll(jid,{name:'?',values:['one','two'],selectableCount:0});assert.equal(state.calls[0].input.selectableCount,0);
  state.pollResponse={};await assert.rejects(client.sendPoll(jid,{name:'?',values:['one','two']}),{status:502});
});
test('poll accepts the application options field and maps it to Evolution values',async()=>{
  const {client,state}=fixture();await client.sendPoll(jid,{name:'?',options:['one','two'],selectableCount:1});assert.deepEqual(state.calls[0].input.values,['one','two']);
});
test('sticker rejects missing, remote, malformed, or oversized content before contacting connector',async()=>{
  const {client,state}=fixture();
  for(const input of [null,{}, {base64:''},{base64:'https://example.com/sticker.webp'},{base64:'data:image/png;base64,aGVsbG8='},{base64:'%invalid%'},{base64:Buffer.alloc(10*1024*1024+1).toString('base64')}]) await assert.rejects(client.sendSticker(jid,input),{status:422});
  assert.equal(state.calls.length,0);
});
test('large valid sticker content reaches the connector without overflowing validation',async()=>{
  const {client,state}=fixture();await assert.rejects(client.sendSticker(jid,{base64:Buffer.alloc(1024*1024).toString('base64')}),{status:503});assert.equal(state.calls.length,1);
});
test('chat identities publish only explicit unambiguous contact aliases',async()=>{
  const {client}=fixture({contacts:[{remoteJid:jid,lid,name:'Saved'}]});
  // Use the normal chat listing API with the same fake connector transport.
  const aliased=createEvolutionClient({apiUrl:'http://127.0.0.1:8767',apiKey:'test',instanceName:'test'},async url=>Response.json(new URL(url).pathname.includes('findContacts')?[{remoteJid:jid,lid,name:'Saved'}]:[{remoteJid:lid},{remoteJid:other}]));
  const chats=await aliased.chats();assert.deepEqual(chats[0].aliasJids,[jid]);assert.deepEqual(chats[1].aliasJids,[]);
});
test('contact details prefer cached saved names and expose only selected profile fields',async()=>{
  const {client,state}=fixture({contacts:[{remoteJid:jid,name:' Saved ',pushName:'Cached',apiKey:'private'}],profile:{wuid:jid,name:'Profile',status:'Public about',isBusiness:true,email:'hello@example.com',website:'https://example.com',picture:'private-avatar-payload',secret:'private'},business:{isBusiness:true,description:'Business',address:'Street',email:'hello@example.com',website:['https://example.com','javascript:alert(1)'],secret:'private'}});
  const result=await client.contactDetails(jid);assert.equal(result.name,'Saved');assert.equal(result.nameSource,'saved');assert.equal(result.phone,'5511998765432');assert.equal(result.about,'Public about');assert.equal(result.business.description,'Business');assert.deepEqual(result.business.websites,['https://example.com/']);
  assert.equal(result.capabilities.disappearingMessages,false);assert.doesNotMatch(JSON.stringify(result),/private|apiKey|picture|secret/);
  assert.deepEqual(state.calls.filter(c=>c.path.includes('fetch')).map(c=>c.input),[{number:jid},{number:jid}]);
});
test('contact details degrade to cached data when optional public profile fetches fail',async()=>{
  const {client}=fixture({contacts:[{remoteJid:jid,name:'Known'}],fail:['/chat/fetchProfile/test','/chat/fetchBusinessProfile/test']});const result=await client.contactDetails(jid);
  assert.equal(result.name,'Known');assert.equal(result.profileAvailable,false);assert.equal(result.about,null);assert.equal(result.business,null);assert.doesNotMatch(JSON.stringify(result),/secret|diagnostic/);
});
test('LID contact details resolve phone only through explicit unambiguous aliases',async()=>{
  const {client}=fixture({contacts:[{remoteJid:jid,lid,name:'Alias'}],profile:{wuid:jid,name:'Profile'},business:{isBusiness:false}});assert.equal((await client.contactDetails(lid)).phone,'5511998765432');
  const unknown=fixture({profile:{wuid:lid},business:{isBusiness:false}});assert.equal((await unknown.client.contactDetails(lid)).phone,null);
});
test('contact details ignore a profile for a different person and validate before fetching',async()=>{
  const {client,state}=fixture({profile:{wuid:other,name:'Wrong',status:'Wrong'},business:{wid:other,isBusiness:true,email:'wrong@example.com'}});const result=await client.contactDetails(jid);
  assert.notEqual(result.name,'Wrong');assert.equal(result.about,null);assert.equal(result.business,null);
  const before=state.calls.length;await assert.rejects(client.contactDetails('123@g.us'),{status:422});assert.equal(state.calls.length,before);
});
test('individual disappearing settings report the supported capability without a fictitious request',async()=>{
  const {client,state}=fixture();
  for(const expiration of [0,86400,604800,7776000]) await assert.rejects(client.disappearingMessages(jid,expiration),error=>error instanceof ApiError && error.status===501 && /celular/i.test(error.message));
  for(const expiration of [1,-1,'86400',null]) await assert.rejects(client.disappearingMessages(jid,expiration),{status:422});
  assert.equal(state.calls.filter(call=>call.method!=='GET').length,0);
});
test('capable connector applies native disappearing settings and exposes the reported current duration',async()=>{
  const {client,state}=fixture({capabilities:{extensionVersion:1,disappearingMessages:true,expiration:604800,updatedAt:1793200000000,source:'whatsapp'}});
  const details=await client.contactDetails(jid);assert.equal(details.capabilities.disappearingMessages,true);assert.equal(details.disappearingMessages.expiration,604800);
  const result=await client.disappearingMessages(jid,86400);assert.equal(result.expiration,86400);
  assert.deepEqual(state.calls.find(call=>call.path==='/chat/updateEphemeral/test'),{path:'/chat/updateEphemeral/test',method:'POST',input:{number:jid,expiration:86400}});
});
test('native timer does not claim success on mismatched or incomplete acknowledgements',async()=>{
  for(const timerResponse of [{},{success:true,jid:other,expiration:86400},{success:true,jid,expiration:604800}]) {
    const {client}=fixture({capabilities:{extensionVersion:1,disappearingMessages:true},timerResponse});await assert.rejects(client.disappearingMessages(jid,86400),{status:502});
  }
});
test('extension validates personal conversations and timer choices before accessing the socket',async()=>{
  const {createExtension}=require('../infra/evolution-extensions.cjs');const sent=[];
  const extension=createExtension({load:()=>({}),save:()=>{}}),service={instanceId:'one',client:{sendMessage:async(...args)=>{sent.push(args);return {};}}},controller={waMonitor:{waInstances:{test:service}}};
  for(const body of [{number:'123@g.us',expiration:86400},{number:jid,expiration:1},{number:jid,expiration:'86400'},null]) {
    const response={status(code){this.code=code;return this;},json(value){this.value=value;return this;}};await extension.ephemeralHandler(controller)({params:{instanceName:'test'},body},response);assert.equal(response.code,422);
  }
  assert.equal(sent.length,0);
});
test('extension relays a native individual timer setting and persists it only after matching confirmation',async()=>{
  const {createExtension}=require('../infra/evolution-extensions.cjs');let saved,observed;const sent=[];
  const extension=createExtension({load:()=>({}),save:state=>{saved=structuredClone(state);}}),service={instanceId:'instance-one',client:{ev:{on(event,handler){if(event==='messages.upsert') observed=handler;}},sendMessage:async(...args)=>{sent.push(args);return {key:{id:'setting'},message:{ephemeralMessage:{message:{protocolMessage:{type:3,ephemeralExpiration:86400}}}}};}}},controller={waMonitor:{waInstances:{test:service}}};
  const response={status(code){this.code=code;return this;},json(value){this.value=value;return this;}};
  await extension.ephemeralHandler(controller)({params:{instanceName:'test'},body:{number:jid,expiration:86400}},response);
  assert.equal(response.code,200);assert.deepEqual(sent,[[jid,{disappearingMessagesInChat:86400}]]);assert.equal(response.value.expiration,86400);assert.equal(extension.expirationFor(service,jid),86400);assert.ok(saved);
  observed({messages:[{key:{remoteJid:jid},message:{protocolMessage:{type:3,ephemeralExpiration:0}},messageTimestamp:Math.floor(Date.now()/1000)+10}]});assert.equal(extension.expirationFor(service,jid),0);
  const restarted=createExtension({load:()=>saved,save:()=>{}});assert.equal(restarted.expirationFor({instanceId:'instance-one',client:{}},jid),0);assert.equal(restarted.expirationFor({instanceId:'instance-two',client:{}},jid),undefined);
});
test('extension does not store timers after ambiguous socket replies or expose socket errors',async()=>{
  const {createExtension}=require('../infra/evolution-extensions.cjs');
  for(const reply of [{},{key:{id:'setting'},message:{protocolMessage:{type:3,ephemeralExpiration:604800}}},new Error('apiKey private')]) {
    let saves=0;const extension=createExtension({load:()=>({}),save:()=>saves++}),service={instanceId:'one',client:{sendMessage:async()=>{if(reply instanceof Error) throw reply;return reply;}}},response={status(code){this.code=code;return this;},json(value){this.value=value;return this;}};
    await extension.ephemeralHandler({waMonitor:{waInstances:{test:service}}})({params:{instanceName:'test'},body:{number:jid,expiration:86400}},response);
    assert.equal(response.code,502);assert.equal(saves,0);assert.doesNotMatch(JSON.stringify(response.value),/private|apiKey/);
  }
});
test('extension ignores stale settings and unsupported metadata, keeping instance state isolated',()=>{
  const {createExtension}=require('../infra/evolution-extensions.cjs');let observe;const extension=createExtension({load:()=>({}),save:()=>{}}),service={instanceId:'one',client:{ev:{on(event,handler){if(event==='messages.upsert') observe=handler;}}}};
  extension.expirationFor(service,jid);observe({messages:[{key:{remoteJid:jid},messageTimestamp:100,message:{protocolMessage:{type:3,ephemeralExpiration:604800}}}]});observe({messages:[{key:{remoteJid:jid},messageTimestamp:99,message:{protocolMessage:{type:3,ephemeralExpiration:0}}},{key:{remoteJid:jid},messageTimestamp:101,message:{protocolMessage:{type:3,ephemeralExpiration:1}}}]});
  assert.equal(extension.expirationFor(service,jid),604800);assert.equal(extension.expirationFor(service,other),undefined);
});
test('extension can observe settings as soon as the socket starts and explicit actions override clock skew',async()=>{
  const {createExtension}=require('../infra/evolution-extensions.cjs');let observe;const extension=createExtension({load:()=>({}),save:()=>{}}),service={instanceId:'one',client:{ev:{on(event,handler){if(event==='messages.upsert') observe=handler;}},sendMessage:async()=>({key:{id:'native'},message:{protocolMessage:{type:3,ephemeralExpiration:0}}})}};
  assert.equal(typeof extension.observe,'function');extension.observe(service);
  observe({messages:[{key:{remoteJid:jid},messageTimestamp:Math.floor(Date.now()/1000)+10,message:{protocolMessage:{type:3,ephemeralExpiration:86400}}}]});
  const response={status(code){this.code=code;return this;},json(value){this.value=value;return this;}};
  await extension.ephemeralHandler({waMonitor:{waInstances:{test:service}}})({params:{instanceName:'test'},body:{number:jid,expiration:0}},response);assert.equal(response.code,200);assert.equal(extension.expirationFor(service,jid),0);
});
test('native timers follow explicit canonical JIDs across LID sends and subsequent phone updates',async()=>{
  const {createExtension}=require('../infra/evolution-extensions.cjs');const sent=[];let observe;
  const extension=createExtension({load:()=>({}),save:()=>{}}),service={instanceId:'one',whatsappNumber:async input=>[{number:input.numbers[0],jid,exists:true}],client:{ev:{on(event,handler){if(event==='messages.upsert') observe=handler;}},sendMessage:async(...args)=>{sent.push(args);return {key:{id:'native',remoteJid:jid},message:{protocolMessage:{type:3,ephemeralExpiration:86400}}};}}};
  const response={status(code){this.code=code;return this;},json(value){this.value=value;return this;}};
  await extension.ephemeralHandler({waMonitor:{waInstances:{test:service}}})({params:{instanceName:'test'},body:{number:lid,expiration:86400}},response);
  assert.equal(response.code,200);assert.equal(sent[0][0],jid);assert.equal(extension.expirationFor(service,lid),86400);assert.equal(extension.expirationFor(service,jid),86400);
  observe({messages:[{key:{remoteJid:jid},messageTimestamp:Math.floor(Date.now()/1000)+1,message:{protocolMessage:{type:3,ephemeralExpiration:0}}}]});assert.equal(extension.expirationFor(service,lid),0);
});
test('bundle patch refuses unknown Evolution versions and content hashes',()=>{
  const {patchBundle}=require('../infra/evolution-extensions.cjs');assert.throws(()=>patchBundle('untrusted','2.3.8'),/versão|version/i);assert.throws(()=>patchBundle('untrusted','2.3.7'),/hash/i);
});
