// Adaptado de menu-hospede/server/admin-whatsapp: a versão local usa consultas periódicas, sem webhook público.
class ApiError extends Error {
  constructor(message,status=502) { super(message);this.status=status; }
}
function assertJid(value) {
  if(typeof value!=='string' || !/^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/.test(value)) throw new ApiError('Escolha uma conversa individual válida.',422);
  return value;
}
function normalizePhone(value) {
  if(typeof value!=='string' || !/^[+\d\s().-]+$/.test(value)) throw new ApiError('Informe o telefone com DDD e código do país.',422);
  let number=value.replace(/\D/g,'');
  if(!value.trim().startsWith('+') && [10,11].includes(number.length)) number='55'+number;
  if(!/^[1-9]\d{7,14}$/.test(number) || /^(\d)\1+$/.test(number)) throw new ApiError('Telefone inválido. Use, por exemplo, +55 11 99999-9999.',422);
  return number;
}
function individualJid(value) {
  return typeof value==='string' && /^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/.test(value)?value:null;
}
function contactName(value) {
  if(typeof value!=='string') return null;
  const name=value.trim();
  return name && !/^[+\d\s().-]+$/.test(name) && !individualJid(name)?name:null;
}
function preferredName(contacts,chat={}) {
  for(const record of [...contacts,chat]) {
    const name=contactName(record.name);if(name) return {name,nameSource:'saved'};
  }
  // Evolution 2.3.7 flattens address-book and profile names into pushName.
  // Its isSaved flag only means a stored contact exists, so it cannot prove name provenance.
  for(const record of [...contacts,chat]) {
    const name=contactName(record.verifiedName) || contactName(record.pushName);
    if(name) return {name,nameSource:'profile'};
  }
  const message=chat.lastMessage;
  if(message?.key?.fromMe===false && message.key.remoteJid===(chat.remoteJid || chat.id)) {
    const name=contactName(message.pushName);if(name) return {name,nameSource:'profile'};
  }
  return null;
}
function contactAliases(contacts,chats) {
  const links=new Map();
  function pair(left,right) {
    if(!individualJid(left) || !individualJid(right) || left.endsWith('@lid')===right.endsWith('@lid')) return;
    for(const [from,to] of [[left,right],[right,left]]) {
      if(!links.has(from)) links.set(from,new Set());links.get(from).add(to);
    }
  }
  for(const contact of contacts) {pair(contact.remoteJid,contact.lid);pair(contact.remoteJid,contact.phoneNumber);}
  for(const chat of chats) {
    const jid=chat.remoteJid || chat.id,key=chat.lastMessage?.key;
    if(key?.remoteJid===jid) pair(jid,key.remoteJidAlt);
  }
  const aliases=new Map();
  for(const [jid,targets] of links) {
    const [target]=targets;
    if(targets.size===1 && links.get(target)?.size===1) aliases.set(jid,target);
  }
  return aliases;
}
function normalizeMessage(raw={}) {
  let content=raw.message || {},ephemeral=false;
  for(let n=0;n<4;n++) {
    if(content.ephemeralMessage?.message) ephemeral=true;
    const nested=content.ephemeralMessage?.message || content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content.documentWithCaptionMessage?.message;
    if(!nested) break;content=nested;
  }
  let type='text',text=content.conversation ?? content.extendedTextMessage?.text ?? '',media=null;
  for(const [key,kind] of [['imageMessage','image'],['videoMessage','video'],['audioMessage','audio'],['documentMessage','document'],['stickerMessage','sticker']]) {
    if(content[key]) {type=kind;media=content[key];text=media.caption || media.fileName || '';break;}
  }
  const pollContent=content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3;
  const poll=pollContent?{name:String(pollContent.name || ''),options:(Array.isArray(pollContent.options)?pollContent.options:[]).map(option=>String(option.optionName || '')),selectableCount:Number(pollContent.selectableOptionsCount)||0}:null;
  if(poll) {type='poll';text=poll.name;}
  let canForward=Boolean(media || (typeof content.conversation==='string' && content.conversation.trim()) || (typeof content.extendedTextMessage?.text==='string' && content.extendedTextMessage.text.trim()));
  if(!text && !media) text=content.contactMessage?.displayName || content.locationMessage?.name || (raw.messageType && raw.messageType!=='conversation'?'['+raw.messageType+']':'');
  let timestamp=Number(raw.messageTimestamp?.low ?? raw.messageTimestamp ?? 0);if(timestamp>0 && timestamp<1e11) timestamp*=1000;
  let status=raw.MessageUpdate?.at(-1)?.status ?? raw.status ?? 'PENDING',key=raw.key || {};
  const protocol=content.protocolMessage;
  const revoke=protocol && [0,'REVOKE'].includes(protocol.type) && typeof protocol.key?.id==='string' && (!protocol.key.remoteJid || protocol.key.remoteJid===key.remoteJid);
  const deleted=key.deleted===true || raw.status==='DELETED' || raw.MessageUpdate?.some(update=>update.status==='DELETED') || revoke;
  if(revoke) key={...protocol.key,remoteJid:key.remoteJid};
  if(deleted) {type='deleted';text='Mensagem apagada';media=null;canForward=false;status='DELETED';}
  const expiration=Number(media?.contextInfo?.expiration ?? content.extendedTextMessage?.contextInfo?.expiration ?? content.messageContextInfo?.expiration ?? raw.contextInfo?.expiration);
  if(Number.isInteger(expiration) && expiration>0) ephemeral=true;
  return {id:key.id || raw.id,jid:key.remoteJid,fromMe:key.fromMe===true,text:String(text),type,timestamp,status,mimeType:media?.mimetype || null,fileName:media?.fileName || null,key,canForward,canDelete:key.fromMe===true && !deleted && Boolean(canForward || poll),...(deleted?{deleted:true}:{}),...(poll && !deleted?{poll}:{}),...(ephemeral?{ephemeral:true,ephemeralExpiration:Number.isInteger(expiration) && expiration>0?expiration:null}:{})};
}
function createEvolutionClient(config={},fetchImpl=fetch) {
  let base;
  try {base=new URL(config.apiUrl);}catch{throw new ApiError('Configuração local ausente. Abra Iniciar WhatsApp.cmd.',503);}
  if(!['http:','https:'].includes(base.protocol) || base.username || base.password || (base.protocol==='http:' && !['127.0.0.1','localhost','[::1]'].includes(base.hostname))) throw new ApiError('Endereço do conector inválido.',503);
  if(!config.apiKey || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.instanceName || '')) throw new ApiError('Configuração da instância inválida.',503);
  const instance=encodeURIComponent(config.instanceName);
  async function request(route,method='GET',input,mediaResponse=false,extraTimeout=0) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),(mediaResponse?90_000:20_000)+extraTimeout),limit=mediaResponse?90_000_000:16_000_000;
    try {
      const response=await fetchImpl(new URL(route,base),{method,signal:controller.signal,headers:{apikey:config.apiKey,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
      if(!response.ok) {await response.body?.cancel();throw new ApiError(`O conector respondeu com erro ${response.status}.`,response.status===404?404:502);}
      let length=0;const chunks=[];
      for await(const chunk of response.body || []) {length+=chunk.length;if(length>limit) {controller.abort();throw new ApiError(mediaResponse?'Este anexo excede o limite de reprodução de 64 MB. Abra o original no WhatsApp.':'Resposta do conector excede o limite.');}chunks.push(chunk);}
      const text=Buffer.concat(chunks).toString('utf8');return text?JSON.parse(text):{};
    } catch(error) {
      if(error instanceof ApiError) throw error;
      throw new ApiError('O conector local não respondeu. Abra Iniciar WhatsApp.cmd e aguarde o Docker.',503);
    } finally {clearTimeout(timer);}
  }
  async function connection() {
    try {
      const result=await request(`/instance/connectionState/${instance}`),raw=result.instance || result;
      const state=['open','connected'].includes(raw.state || raw.status)?'connected':['connecting','pairing'].includes(raw.state || raw.status)?'connecting':'disconnected';
      let phone=null;
      if(state==='connected') {
        const result=await request(`/instance/fetchInstances?instanceName=${instance}`);
        const found=(Array.isArray(result)?result:[]).find(item=>(item.name || item.instance?.instanceName)===config.instanceName);
        const owner=found?.ownerJid || found?.instance?.owner || '';
        phone=owner.endsWith('@s.whatsapp.net')?owner.split('@')[0].split(':')[0]:null;
      }
      return {state,reachable:true,exists:true,phone,instanceName:config.instanceName};
    } catch(error) {
      if(error.status===404) return {state:'disconnected',reachable:true,exists:false,phone:null,instanceName:config.instanceName};
      return {state:'unreachable',reachable:false,exists:false,phone:null,instanceName:config.instanceName,message:error.message};
    }
  }
  let contacts=[],contactsByJid=new Map(),contactsPending,lastContactsAttempt=-Infinity;
  let contactsSummary={total:0,named:0,lastSyncAt:null};
  const deletedMessages=new Map();
  function rememberDeleted(message) {
    if(message.deleted && message.id && message.jid) {
      deletedMessages.set(message.jid+'\n'+message.id,true);
      if(deletedMessages.size>2000) deletedMessages.delete(deletedMessages.keys().next().value);
    }
    return message;
  }
  function normalized(raw) {
    const message=rememberDeleted(normalizeMessage(raw));
    return deletedMessages.has(message.jid+'\n'+message.id)?normalizeMessage({...raw,key:{...raw.key,deleted:true}}):message;
  }
  async function originalMessage(jid,id) {
    assertJid(jid);
    if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new ApiError('Escolha uma mensagem válida.',422);
    const result=await request(`/chat/findMessages/${instance}`,'POST',{where:{key:{id,remoteJid:jid}},page:1,offset:1});
    const data=result.messages || result,records=Array.isArray(data)?data:data.records || [];
    const found=records.find(item=>item.key?.id===id && item.key?.remoteJid===jid);
    if(!found) throw new ApiError('A mensagem original não foi encontrada nesta conversa.',404);
    return normalized(found);
  }
  async function localCapabilities(jid) {
    try {
      const result=await request(`/chat/localCapabilities/${instance}?number=${encodeURIComponent(jid)}`);
      const supported=result.extensionVersion===1 && result.disappearingMessages===true;
      return {supported,expiration:supported && [0,86400,604800,7776000].includes(result.expiration)?result.expiration:null,updatedAt:typeof result.updatedAt==='number' && Number.isFinite(result.updatedAt)?result.updatedAt:null,source:['central','whatsapp'].includes(result.source)?result.source:null};
    } catch {return {supported:false,expiration:null,updatedAt:null,source:null};}
  }
  function syncContacts(force=false) {
    if(contactsPending) return contactsPending;
    if(!force && Date.now()-lastContactsAttempt<5*60_000) return Promise.resolve({...contactsSummary});
    lastContactsAttempt=Date.now();
    contactsPending=(async()=>{
      try {
        const result=await request(`/chat/findContacts/${instance}`,'POST',{});
        const rows=Array.isArray(result)?result:result?.contacts;
        if(!Array.isArray(rows)) throw new ApiError('Resposta de contatos inválida.');
        const next=rows.filter(item=>item && individualJid(item.remoteJid || item.id)).map(item=>({...item,remoteJid:item.remoteJid || item.id}));
        contacts=next;contactsByJid=new Map(next.map(item=>[item.remoteJid,item]));
        contactsSummary={total:contactsByJid.size,named:[...contactsByJid.values()].filter(item=>preferredName([item])).length,lastSyncAt:new Date(Date.now()).toISOString()};
      } catch {
        contactsSummary={...contactsSummary,error:'Não foi possível atualizar os contatos do WhatsApp. Os nomes já carregados foram mantidos.'};
      }
      return {...contactsSummary};
    })().finally(()=>{contactsPending=null;});
    return contactsPending;
  }
  let connecting;
  return {
    connection,
    syncContacts,
    connect() {
      if(connecting) return connecting;
      connecting=(async()=>{
        const state=await connection();
        if(!state.reachable) throw new ApiError(state.message,503);
        if(state.state==='connected') return {...state,base64:null};
        if(!state.exists) await request('/instance/create','POST',{instanceName:config.instanceName,integration:'WHATSAPP-BAILEYS',qrcode:true,syncFullHistory:false,groupsIgnore:true,readMessages:false,readStatus:false,alwaysOnline:false});
        const result=await request(`/instance/connect/${instance}`),raw=result.base64 || result.qrcode?.base64;
        const base64=typeof raw==='string'?(raw.startsWith('data:image/png;base64,')?raw:`data:image/png;base64,${raw}`):null;
        if(base64 && !/^data:image\/png;base64,[a-zA-Z0-9+/=\r\n]+$/.test(base64)) throw new ApiError('QR Code inválido recebido do conector.');
        return {state:'connecting',base64,count:result.count ?? 0};
      })().finally(()=>{connecting=null;});
      return connecting;
    },
    disconnect:()=>request(`/instance/logout/${instance}`,'DELETE'),
    async chats() {
      const [result]=await Promise.all([request(`/chat/findChats/${instance}`,'POST',{}),syncContacts()]);
      const rows=(Array.isArray(result)?result:result.chats || []).filter(item=>item && individualJid(item.remoteJid || item.id));
      const aliases=contactAliases(contacts,rows);
      return rows.map(item=>{
        const jid=item.remoteJid || item.id,alias=aliases.get(jid);
        const records=[contactsByJid.get(jid),contactsByJid.get(alias)].filter(Boolean);
        const phoneJid=jid.endsWith('@s.whatsapp.net')?jid:alias?.endsWith('@s.whatsapp.net')?alias:null;
        const phone=phoneJid?.split('@')[0];
        return {jid,aliasJids:alias?[alias]:[],...(preferredName(records,item) || {name:phone || jid.split('@')[0],nameSource:'number'}),...(phone?{phone}:{}),unread:Math.max(0,Number(item.unreadCount)||0),lastMessage:item.lastMessage?normalized(item.lastMessage):null};
      });
    },
    message:originalMessage,
    async deleteMessage(jid,id) {
      const message=await originalMessage(jid,id);
      if(!message.canDelete) throw new ApiError('Só é possível apagar para todos uma mensagem enviada por você e disponível nesta conversa.',422);
      const result=await request(`/chat/deleteMessageForEveryone/${instance}`,'DELETE',{id:message.id,remoteJid:message.jid,fromMe:true});
      const protocol=result.message?.protocolMessage;
      if(!result.key?.id || ![0,'REVOKE'].includes(protocol?.type) || protocol.key?.id!==id || (protocol.key.remoteJid && protocol.key.remoteJid!==jid)) throw new ApiError('O conector não confirmou que a mensagem foi apagada. Confira a conversa no celular antes de tentar novamente.');
      rememberDeleted({...message,deleted:true});return {id,jid,deleted:true,scope:'everyone'};
    },
    async messages(jid,page=1) {
      assertJid(jid);
      const result=await request(`/chat/findMessages/${instance}`,'POST',{where:{key:{remoteJid:jid}},page,offset:50});
      const data=result.messages || result,records=Array.isArray(data)?data:data.records || [];
      const messages=records.map(normalizeMessage);messages.forEach(rememberDeleted);
      const unique=new Map();
      for(const raw of records) {
        const message=normalized(raw),previous=unique.get(message.id);
        if(previous && !message.timestamp) message.timestamp=previous.timestamp;
        if(!previous || message.deleted || !previous.deleted) unique.set(message.id,message);
      }
      return {messages:[...unique.values()].sort((a,b)=>a.timestamp-b.timestamp),page:Number(data.currentPage)||page,pages:Number(data.pages)||1,total:Number(data.total)||records.length};
    },
    // `delay` (ms) mostra "digitando…" no WhatsApp do contato por esse tempo antes de enviar.
    async sendText(jid,text,{delay=0}={}) {
      const typing=Number.isFinite(delay) && delay>0?Math.min(Math.round(delay),60_000):0;
      const result=await request(`/message/sendText/${instance}`,'POST',{number:assertJid(jid),text,linkPreview:false,...(typing?{delay:typing}:{})},false,typing);
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio. Confira a conversa antes de tentar novamente.');
      return normalizeMessage(result);
    },
    async sendMedia(jid,input) {
      const result=await request(`/message/sendMedia/${instance}`,'POST',{number:assertJid(jid),mediatype:input.mediaType,mimetype:input.mimeType,fileName:input.fileName,media:input.base64,caption:input.caption || ''});
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio do anexo.');return normalizeMessage(result);
    },
    async sendSticker(jid,input) {
      assertJid(jid);
      if(typeof input?.base64!=='string' || !input.base64 || input.base64.length>14_000_000 || input.base64.length%4!==0 || Buffer.byteLength(input.base64,'base64')>10*1024*1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new ApiError('Figurinha inválida. Envie uma imagem de até 10 MB.',422);
      const result=await request(`/message/sendSticker/${instance}`,'POST',{number:jid,sticker:input.base64});
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio da figurinha.');return normalizeMessage(result);
    },
    async sendPoll(jid,input) {
      assertJid(jid);
      if(input && input.values===undefined && input.options!==undefined) input={...input,values:input.options};
      if(!input || typeof input!=='object' || typeof input.name!=='string' || !input.name.trim() || input.name.trim().length>300 || !Array.isArray(input.values) || input.values.length<2 || input.values.length>10 || input.values.some(value=>typeof value!=='string' || !value.trim() || value.trim().length>100)) throw new ApiError('Informe a pergunta e de 2 a 10 opções para a enquete.',422);
      const values=input.values.map(value=>value.trim()),selectableCount=input.selectableCount ?? 1;
      if(new Set(values.map(value=>value.toLocaleLowerCase('pt-BR'))).size!==values.length || !Number.isInteger(selectableCount) || selectableCount<0 || selectableCount>values.length) throw new ApiError('Use opções diferentes e uma quantidade válida de respostas.',422);
      const result=await request(`/message/sendPoll/${instance}`,'POST',{number:jid,name:input.name.trim(),values,selectableCount});
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio da enquete. Confira a conversa antes de tentar novamente.');
      return normalizeMessage(result);
    },
    async contactDetails(jid) {
      assertJid(jid);await syncContacts();
      const alias=contactAliases(contacts,[]).get(jid),phoneJid=jid.endsWith('@s.whatsapp.net')?jid:alias?.endsWith('@s.whatsapp.net')?alias:null;
      const records=[contactsByJid.get(jid),contactsByJid.get(alias)].filter(Boolean);
      const [profileResult,businessResult,disappearingMessages]=await Promise.all([request(`/chat/fetchProfile/${instance}`,'POST',{number:phoneJid || jid}).then(value=>({status:'fulfilled',value}),()=>({status:'rejected'})),request(`/chat/fetchBusinessProfile/${instance}`,'POST',{number:phoneJid || jid}).then(value=>({status:'fulfilled',value}),()=>({status:'rejected'})),localCapabilities(jid)]);
      const allowed=new Set([jid,alias].filter(Boolean));
      const safeResult=result=>result.status==='fulfilled' && result.value && typeof result.value==='object' && ![result.value.wuid,result.value.wid,result.value.jid].some(id=>id && !allowed.has(id))?result.value:null;
      const profile=safeResult(profileResult),business=safeResult(businessResult);
      const publicText=(value,max=1000)=>typeof value==='string' && value.trim()?value.trim().slice(0,max):null;
      const publicUrl=value=>{try {const url=new URL(value);return ['https:','http:'].includes(url.protocol) && !url.username && !url.password?url.href:null;}catch{return null;}};
      const websites=[...(Array.isArray(business?.website)?business.website:[]),...(Array.isArray(business?.websites)?business.websites:[]),profile?.website].filter(value=>typeof value==='string').map(publicUrl).filter(Boolean);
      return {jid,...(preferredName(records) || preferredName([{pushName:profile?.name}]) || {name:phoneJid?.split('@')[0] || jid.split('@')[0],nameSource:'number'}),phone:phoneJid?.split('@')[0] || null,about:publicText(profile?.status),profileAvailable:Boolean(profile),business:business?.isBusiness===true || profile?.isBusiness===true?{description:publicText(business?.description || profile?.description),address:publicText(business?.address),email:publicText(business?.email || profile?.email,254),websites:[...new Set(websites)].slice(0,5)}:null,disappearingMessages,capabilities:{deleteForEveryone:true,polls:true,stickers:true,disappearingMessages:disappearingMessages.supported}};
    },
    async disappearingMessages(jid,expiration) {
      assertJid(jid);
      if(![0,86400,604800,7776000].includes(expiration)) throw new ApiError('Escolha desativadas, 24 horas, 7 dias ou 90 dias.',422);
      const capability=await localCapabilities(jid);
      if(!capability.supported) throw new ApiError('Esta versão do conector não altera mensagens temporárias em conversas individuais. Altere essa opção no WhatsApp do celular.',501);
      const result=await request(`/chat/updateEphemeral/${instance}`,'POST',{number:jid,expiration});
      if(result.success!==true || result.jid!==jid || result.expiration!==expiration) throw new ApiError('O conector não confirmou a alteração. Confira a conversa no celular antes de tentar novamente.');
      return {jid,expiration,updatedAt:typeof result.updatedAt==='number'?result.updatedAt:null,source:'central',success:true};
    },
    read:(jid,keys)=>request(`/chat/markMessageAsRead/${instance}`,'POST',{readMessages:[...new Map(keys.map(key=>[key.id,{id:key.id,remoteJid:assertJid(jid),fromMe:false}])).values()]}),
    media:(jid,id)=>request(`/chat/getBase64FromMediaMessage/${instance}`,'POST',{message:{key:{id,remoteJid:assertJid(jid)}}},true),
    profile:jid=>request(`/chat/fetchProfilePictureUrl/${instance}`,'POST',{number:assertJid(jid)}),
    async resolvePhone(phone) {
      const number=normalizePhone(phone),result=await request(`/chat/whatsappNumbers/${instance}`,'POST',{numbers:[number]});
      const record=(Array.isArray(result)?result:result.numbers || [])[0];
      if(!record?.exists) throw new ApiError('Este número não foi encontrado no WhatsApp.',422);
      return {jid:assertJid(record.jid || number+'@s.whatsapp.net'),name:record.name || number};
    }
  };
}
module.exports={createEvolutionClient,ApiError,assertJid,normalizePhone,normalizeMessage};
