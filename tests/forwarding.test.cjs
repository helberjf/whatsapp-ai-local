const {test}=require('node:test');
const assert=require('node:assert/strict');
const {forwardMessage}=require('../lib/forwarding.cjs');
const {normalizeMessage}=require('../lib/evolution.cjs');
const sourceJid='5511998765432@s.whatsapp.net',targetJid='5521998765432@s.whatsapp.net';
const input={sourceJid,targetJid,messageId:'original-1'};
function client(message,media={base64:'aGVsbG8=',mimetype:'audio/ogg'}) {const sends=[];return {sends,message:async(jid,id)=>{assert.equal(jid,sourceJid);assert.equal(id,'original-1');return {id,jid,...message};},media:async()=>media,sendText:async(...args)=>{sends.push(['text',...args]);return {id:'sent'};},sendMedia:async(...args)=>{sends.push(['media',...args]);return {id:'sent'};},sendSticker:async(...args)=>{sends.push(['sticker',...args]);return {id:'sent'};}};}
test('encaminha conteúdo original obtido no servidor para o destino explícito',async()=>{
  const c=client({type:'text',text:'Texto original'});await forwardMessage(c,{...input,text:'Texto adulterado'});assert.deepEqual(c.sends,[['text',targetJid,'Texto original']]);
});
test('áudio, foto, vídeo e documento usam base64 e legenda original sem URLs arbitrárias',async()=>{
  for(const type of ['audio','image','video','document']) {
    const c=client({type,text:type==='document'?'arquivo.pdf':'Legenda',fileName:'arquivo.pdf',mimeType:'application/pdf'});await forwardMessage(c,input);assert.equal(c.sends[0][0],'media');assert.equal(c.sends[0][1],targetJid);assert.equal(c.sends[0][2].base64,'aGVsbG8=');assert.equal(c.sends[0][2].mediaType,type);assert.equal(c.sends[0][2].caption,type==='document'?'':'Legenda');
  }
  const c=client({type:'sticker',text:''});await forwardMessage(c,input);assert.equal(c.sends[0][0],'sticker');
});
test('valida fonte, destino, mensagem real e limite de mídia antes de enviar',async()=>{
  const c=client({type:'text',text:'Olá'});
  await assert.rejects(forwardMessage(c,{...input,targetJid:'123@g.us'}),{status:422});
  await assert.rejects(forwardMessage(c,{...input,messageId:'../file'}),{status:422});
  await assert.rejects(forwardMessage(client({type:'text',text:'Olá',jid:targetJid}),input),{status:404});
  await assert.rejects(forwardMessage(client({type:'text',text:'',id:'other'}),input),{status:404});
  await assert.rejects(forwardMessage(client({type:'image',text:''},{base64:'https://evil.example/file'}),input),{status:422});
  await assert.rejects(forwardMessage(client({type:'video',text:''},{base64:Buffer.alloc(10*1024*1024+1).toString('base64')}),input),{status:422});
  await assert.rejects(forwardMessage(client({type:'unknown',text:'Sistema'}),input),{status:422});assert.equal(c.sends.length,0);
});
test('contato, localização e mensagens de sistema não viram texto substituto ao encaminhar',async()=>{
  for(const [messageType,message] of [['reactionMessage',{reactionMessage:{text:'👍'}}],['contactMessage',{contactMessage:{displayName:'Contato',vcard:'conteúdo original'}}],['locationMessage',{locationMessage:{name:'Local',degreesLatitude:1,degreesLongitude:2}}],['protocolMessage',{protocolMessage:{type:0}}]]) {
    const original=normalizeMessage({key:{id:'original-1',remoteJid:sourceJid,fromMe:false},messageType,message});
    const c=client(original);await assert.rejects(forwardMessage(c,input),{status:422});assert.equal(c.sends.length,0);
  }
});
