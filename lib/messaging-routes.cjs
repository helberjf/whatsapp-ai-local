const {ApiError,assertJid}=require('./evolution.cjs');

// Recursos do WhatsApp além do envio básico: responder, reagir, editar, localização, contato, voz,
// organização das conversas (fixar, silenciar, arquivar, não lida, bloquear), favoritas, perfil e privacidade.
const MAX_PINNED=3,MAX_STARRED=500;
const contactBase=()=>({status:'open',labels:[],notes:[]});
const MUTE_HOURS=[0,8,168,-1];
const messageId=(value,label='Mensagem')=>{if(typeof value!=='string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value) || value.includes('..')) throw new ApiError(`${label} inválida.`,422);return value;};
const optionalQuote=value=>value===undefined || value===null || value===''?undefined:messageId(value,'Mensagem citada');
const isAudioMime=value=>typeof value==='string' && /^audio\/[\w.+-]+(;\s*codecs=[\w.+-]+)?$/i.test(value);
const base64Of=(value,max)=>typeof value==='string' && value.length>0 && value.length%4===0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.byteLength(value,'base64')<=max;

function chatState(contact={},at=Date.now()) {
  const mutedUntil=contact.mutedUntil==='always'?'always':Number.isFinite(Date.parse(contact.mutedUntil || ''))&&Date.parse(contact.mutedUntil)>at?contact.mutedUntil:null;
  return {pinned:contact.pinned===true,pinnedAt:contact.pinned===true?contact.pinnedAt || null:null,archived:contact.archived===true,markedUnread:contact.markedUnread===true,blocked:contact.blocked===true,mutedUntil};
}

function createMessagingRoutes({client,store,sendOnce,voice,speech,avatars,now=Date.now}) {
  const ok=(body,status=200)=>({status,body});
  async function updateContact(jid,fn) {
    return store.update(data=>{data.contacts ||= {};const contact=data.contacts[jid]={...contactBase(),...data.contacts[jid]};fn(contact,data);return {jid,...chatState(contact,now())};});
  }
  return async function handle(req,route,url,readBody) {
    const method=req.method;
    if(method==='POST' && route==='/api/messages/react') {
      const input=await readBody(req),jid=assertJid(input.jid),id=messageId(input.messageId);
      if(typeof input.emoji!=='string') throw new ApiError('Escolha uma reação válida.',422);
      return ok(await sendOnce(input,()=>client.sendReaction(jid,id,input.emoji)));
    }
    if(method==='POST' && route==='/api/messages/edit') {
      const input=await readBody(req),jid=assertJid(input.jid),id=messageId(input.messageId);
      if(typeof input.text!=='string' || !input.text.trim() || input.text.length>10000) throw new ApiError('Mensagem: informe de 1 a 10000 caracteres.',422);
      return ok(await sendOnce(input,()=>client.editMessage(jid,id,input.text)));
    }
    if(method==='POST' && route==='/api/send-location') {
      const input=await readBody(req),jid=assertJid(input.jid),quotedId=optionalQuote(input.quotedId);
      return ok(await sendOnce(input,()=>client.sendLocation(jid,{latitude:input.latitude,longitude:input.longitude,name:input.name,address:input.address,quotedId})));
    }
    if(method==='POST' && route==='/api/send-contact') {
      const input=await readBody(req),jid=assertJid(input.jid);
      return ok(await sendOnce(input,()=>client.sendContact(jid,{fullName:input.fullName,phone:input.phone,organization:input.organization,email:input.email})));
    }
    if(method==='POST' && route==='/api/send-voice') {
      const input=await readBody(req),jid=assertJid(input.jid),quotedId=optionalQuote(input.quotedId);
      if(!isAudioMime(input.mimeType) || !base64Of(input.base64,10*1024*1024)) throw new ApiError('Áudio inválido. Grave ou escolha um áudio de até 10 MB.',422);
      return ok(await sendOnce(input,()=>client.sendVoice(jid,{base64:input.base64,quotedId})));
    }
    if(method==='POST' && route==='/api/presence') {
      const input=await readBody(req),jid=assertJid(input.jid);
      if(!['composing','recording','paused'].includes(input.presence)) throw new ApiError('Presença inválida.',422);
      const data=await store.read();if(data.chatPreferences?.shareTyping===false) return ok({jid,presence:input.presence,skipped:true});
      return ok(await client.presence(jid,input.presence,input.presence==='paused'?0:4000));
    }
    if(route==='/api/chat-preferences' && ['GET','PUT'].includes(method)) {
      if(method==='GET') {const data=await store.read();return ok({shareTyping:data.chatPreferences?.shareTyping!==false});}
      const input=await readBody(req);if(typeof input.shareTyping!=='boolean' || Object.keys(input).some(key=>key!=='shareTyping')) throw new ApiError('Preferência inválida.',422);
      return ok(await store.update(data=>{data.chatPreferences={...data.chatPreferences,shareTyping:input.shareTyping};return {shareTyping:input.shareTyping};}));
    }
    if(method==='PATCH' && route==='/api/chat-state') {
      const jid=assertJid(url.searchParams.get('jid')),input=await readBody(req);
      const allowed=['pinned','archived','markedUnread','blocked','muteHours'];
      if(!Object.keys(input).length || Object.keys(input).some(key=>!allowed.includes(key))) throw new ApiError('Escolha uma ação válida para a conversa.',422);
      for(const key of ['pinned','archived','markedUnread','blocked']) if(input[key]!==undefined && typeof input[key]!=='boolean') throw new ApiError('Ação da conversa inválida.',422);
      if(input.muteHours!==undefined && !MUTE_HOURS.includes(input.muteHours)) throw new ApiError('Silencie por 8 horas, 1 semana ou sempre.',422);
      if(input.pinned===true) {
        const data=await store.read(),pinned=Object.entries(data.contacts || {}).filter(([key,contact])=>key!==jid && contact.pinned===true);
        if(pinned.length>=MAX_PINNED) throw new ApiError(`Você pode fixar até ${MAX_PINNED} conversas, como no WhatsApp. Desafixe outra antes.`,409);
      }
      // Operações nativas primeiro: só gravamos o estado local depois da confirmação do WhatsApp.
      if(input.blocked!==undefined) await client.blockContact(jid,input.blocked);
      if(input.archived!==undefined) await client.archiveChat(jid,input.archived);
      if(input.markedUnread===true) await client.markChatUnread(jid);
      return ok(await updateContact(jid,contact=>{
        if(input.pinned!==undefined) {contact.pinned=input.pinned;contact.pinnedAt=input.pinned?new Date(now()).toISOString():null;}
        if(input.archived!==undefined) {contact.archived=input.archived;contact.archivedAt=new Date(now()).toISOString();if(input.archived) {contact.pinned=false;contact.pinnedAt=null;}}
        if(input.markedUnread!==undefined) contact.markedUnread=input.markedUnread;
        if(input.blocked!==undefined) contact.blocked=input.blocked;
        if(input.muteHours!==undefined) contact.mutedUntil=input.muteHours===0?null:input.muteHours===-1?'always':new Date(now()+input.muteHours*3600_000).toISOString();
      }));
    }
    if(method==='GET' && route==='/api/blocked') {
      const data=await store.read();
      return ok(Object.entries(data.contacts || {}).filter(([,contact])=>contact.blocked===true).map(([jid])=>({jid})));
    }
    if(route==='/api/starred' && method==='GET') {
      const data=await store.read();return ok(Object.values(data.starred || {}).sort((a,b)=>b.at-a.at));
    }
    if(route==='/api/starred' && method==='PUT') {
      const input=await readBody(req),jid=assertJid(input.jid),id=messageId(input.messageId);
      if(typeof input.starred!=='boolean') throw new ApiError('Escolha favoritar ou remover das favoritas.',422);
      const key=jid+'|'+id;
      if(!input.starred) {await store.update(data=>{if(data.starred) delete data.starred[key];});return ok({jid,messageId:id,starred:false});}
      const message=await client.message(jid,id);
      if(message.deleted || message.type==='reaction') throw new ApiError('Esta mensagem não pode ser favoritada.',422);
      const entry={jid,messageId:id,starred:true,fromMe:message.fromMe,type:message.type,text:String(message.text || '').slice(0,500),timestamp:message.timestamp || null,at:now()};
      await store.update(data=>{
        data.starred ||= {};data.starred[key]=entry;const keys=Object.keys(data.starred);
        if(keys.length>MAX_STARRED) for(const old of keys.sort((a,b)=>data.starred[a].at-data.starred[b].at).slice(0,keys.length-MAX_STARRED)) delete data.starred[old];
      });
      return ok(entry);
    }
    if(route==='/api/profile' && method==='GET') return ok(await client.ownProfile());
    if(route==='/api/profile' && method==='PATCH') {
      const input=await readBody(req);
      if(Object.keys(input).some(key=>!['name','about'].includes(key)) || (input.name===undefined && input.about===undefined)) throw new ApiError('Altere o nome ou o recado.',422);
      const result={};
      if(input.name!==undefined) Object.assign(result,await client.updateProfileName(input.name));
      if(input.about!==undefined) Object.assign(result,await client.updateProfileAbout(input.about));
      return ok(result);
    }
    if(route==='/api/profile/picture' && method==='PUT') {
      const input=await readBody(req),mime=input.mimeType;
      if(!['image/jpeg','image/png'].includes(mime) || !base64Of(input.base64,5*1024*1024)) throw new ApiError('Envie uma foto JPG ou PNG de até 5 MB.',422);
      const bytes=Buffer.from(input.base64,'base64'),valid=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
      if(!valid) throw new ApiError('O arquivo não parece ser uma foto JPG ou PNG.',422);
      const result=await client.updateProfilePicture(input.base64);avatars?.forget?.();return ok(result);
    }
    if(route==='/api/profile/picture' && method==='DELETE') {const result=await client.removeProfilePicture();avatars?.forget?.();return ok(result);}
    if(route==='/api/privacy' && method==='GET') return ok(await client.privacySettings());
    if(route==='/api/privacy' && method==='PUT') return ok(await client.updatePrivacySettings(await readBody(req)));
    if(route==='/api/voice-flow' && ['GET','PUT'].includes(method)) return ok(method==='GET'?await voice.view():await voice.save(await readBody(req)));
    if(route==='/api/voice/voices' && method==='GET') return ok({windowsAvailable:speech?.windowsAvailable===true,voices:await speech?.voices?.() || []});
    if(route==='/api/voice/preview' && method==='POST') {
      const input=await readBody(req);if(typeof input.text!=='string' || !input.text.trim() || input.text.length>4000) throw new ApiError('Escreva um texto para ouvir.',422);
      const audio=await voice.synthesize(input.text);return ok({base64:audio.base64,mimeType:audio.mimeType,provider:audio.provider});
    }
    if(route==='/api/voice/speak' && method==='POST') {
      const input=await readBody(req),jid=assertJid(input.jid),quotedId=optionalQuote(input.quotedId);
      if(typeof input.text!=='string' || !input.text.trim() || input.text.length>4000) throw new ApiError('Escreva o texto que será enviado em áudio.',422);
      return ok(await sendOnce(input,()=>voice.speakAndSend(jid,input.text,{quotedId})));
    }
    return undefined;
  };
}
module.exports={createMessagingRoutes,chatState,MAX_PINNED};
