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
function groupJid(value) {
  return typeof value==='string' && /^\d{1,20}(?:-\d{1,20})?@g\.us$/.test(value);
}
function assertConversationJid(value) {
  return groupJid(value)?value:assertJid(value);
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
const QUOTED_KINDS=[['imageMessage','image','Imagem'],['videoMessage','video','Vídeo'],['audioMessage','audio','Áudio'],['documentMessage','document','Documento'],['stickerMessage','sticker','Figurinha'],['locationMessage','location','Localização'],['contactMessage','contact','Contato']];
// Resposta citada: o WhatsApp guarda o id (stanzaId) e uma cópia resumida da mensagem original em contextInfo.
function quotedOf(info,remoteJid) {
  const id=typeof info?.stanzaId==='string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(info.stanzaId)?info.stanzaId:null,quoted=info?.quotedMessage;
  if(!id || !quoted || typeof quoted!=='object') return null;
  let type='text',text=quoted.conversation ?? quoted.extendedTextMessage?.text ?? '';
  for(const [key,kind,label] of QUOTED_KINDS) if(quoted[key]) {type=kind;text=quoted[key].caption || quoted[key].fileName || quoted[key].name || quoted[key].displayName || label;break;}
  const poll=quoted.pollCreationMessage || quoted.pollCreationMessageV2 || quoted.pollCreationMessageV3;if(poll) {type='poll';text=poll.name || 'Enquete';}
  const participant=typeof info.participant==='string'?info.participant:null;
  return {id,type,text:String(text || '').slice(0,300),fromMe:participant?participant!==remoteJid:null};
}
// O vCard do WhatsApp traz o número em TEL;waid=...; outros formatos são lidos só pelos dígitos.
function vcardPhones(vcard) {
  const phones=[];
  for(const line of String(vcard || '').split(/\r?\n/).slice(0,80)) {
    const match=line.match(/^(?:[\w-]+\.)?TEL([^:]*):(.*)$/i);if(!match) continue;
    const number=match[1].match(/waid=(\d{6,20})/i)?.[1] || match[2].replace(/\D/g,'');
    if(/^\d{6,20}$/.test(number)) phones.push(number);
  }
  return [...new Set(phones)].slice(0,5);
}
function jpegThumbnail(value) {
  const limit=256*1024;let bytes;
  if(typeof value==='string') {
    const encoded=value.trim();
    if(!encoded || encoded.length>Math.ceil(limit/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length%4===1 || (encoded.includes('=') && encoded.length%4!==0)) return null;
    bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64').replace(/=+$/,'')!==encoded.replace(/=+$/,'')) return null;
  }else if(value instanceof Uint8Array) {
    if(value.byteLength>limit) return null;bytes=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  }else {
    let values;
    if(Array.isArray(value)) values=value;
    else if(value?.type==='Buffer' && Array.isArray(value.data)) values=value.data;
    else if(value && typeof value==='object') {
      const keys=Object.keys(value);
      if(!keys.length || keys.length>limit || keys.some((key,index)=>key!==String(index))) return null;
      values=keys.map(key=>value[key]);
    }
    if(!values || !values.length || values.length>limit) return null;
    for(const byte of values) if(!Number.isInteger(byte) || byte<0 || byte>255) return null;
    bytes=Buffer.from(values);
  }
  // A prévia só contém bytes JPEG locais; nenhum endereço do conector é repassado.
  if(bytes.length<3 || bytes.length>limit || bytes[0]!==0xff || bytes[1]!==0xd8 || bytes[2]!==0xff) return null;
  return bytes.toString('base64');
}
const deliveryStates=['failed','pending','sent','delivered','read','played'];
const deliveryCodes=new Map([
  ['ERROR',0],['FAILED',0],['PENDING',1],['SERVER_ACK',2],['SENT',2],
  ['DELIVERY_ACK',3],['DELIVERED',3],['READ',4],['PLAYED',5]
]);
function deliveryStatusOf(raw) {
  let progress=-1,failed=false;
  for(const status of [raw.status,...(raw.MessageUpdate || []).map(update=>update.status)]) {
    const code=typeof status==='number'?status:deliveryCodes.get(status);
    if(code===0) failed=true;
    else if(deliveryStates[code] && code>progress) progress=code;
  }
  return failed && progress<2?'failed':deliveryStates[progress] || 'unknown';
}
function normalizeMessage(raw={}) {
  let content=raw.message || {},ephemeral=false,viewOnce=false;
  for(let n=0;n<4;n++) {
    if(content.ephemeralMessage?.message) ephemeral=true;
    const once=content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content.viewOnceMessageV2Extension?.message;
    if(once) viewOnce=true;
    const nested=content.ephemeralMessage?.message || once || content.documentWithCaptionMessage?.message;
    if(!nested) break;content=nested;
  }
  let type='text',text=content.conversation ?? content.extendedTextMessage?.text ?? '',media=null;
  for(const [key,kind] of [['imageMessage','image'],['videoMessage','video'],['audioMessage','audio'],['documentMessage','document'],['stickerMessage','sticker']]) {
    if(content[key]) {type=kind;media=content[key];text=media.caption || media.fileName || '';break;}
  }
  const pollContent=content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3;
  const poll=pollContent?{name:String(pollContent.name || ''),options:(Array.isArray(pollContent.options)?pollContent.options:[]).map(option=>String(option.optionName || '')),selectableCount:Number(pollContent.selectableOptionsCount)||0}:null;
  if(poll) {type='poll';text=poll.name;}
  let reaction=null,location=null,contacts=null;
  if(content.reactionMessage) {
    const target=content.reactionMessage.key || {};
    reaction={targetId:typeof target.id==='string'?target.id:null,emoji:String(content.reactionMessage.text || '').slice(0,32)};
    type='reaction';text=reaction.emoji;
  }
  const place=content.locationMessage || content.liveLocationMessage;
  if(place) {
    const latitude=Number(place.degreesLatitude),longitude=Number(place.degreesLongitude);
    location={latitude:Number.isFinite(latitude)?latitude:null,longitude:Number.isFinite(longitude)?longitude:null,name:typeof place.name==='string'?place.name.slice(0,300):null,address:typeof place.address==='string'?place.address.slice(0,500):null,live:Boolean(content.liveLocationMessage)};
    type='location';text=location.name || location.address || 'Localização';
  }
  const cards=content.contactMessage?[content.contactMessage]:Array.isArray(content.contactsArrayMessage?.contacts)?content.contactsArrayMessage.contacts.slice(0,10):null;
  if(cards) {contacts=cards.map(card=>({name:String(card?.displayName || 'Contato').slice(0,160),phones:vcardPhones(card?.vcard)}));type='contact';text=contacts.map(card=>card.name).join(', ');}
  // Voto em enquete: a Evolution grava os nomes das opções já decifrados. Não é uma mensagem a responder.
  let vote=null;
  if(content.pollUpdateMessage) {
    const selected=content.pollUpdateMessage.vote?.selectedOptions;
    vote={pollId:typeof content.pollUpdateMessage.pollCreationMessageKey?.id==='string'?content.pollUpdateMessage.pollCreationMessageKey.id:null,options:(Array.isArray(selected)?selected:[]).filter(item=>typeof item==='string').map(item=>item.slice(0,100)).slice(0,10)};
    type='poll_vote';text=vote.options.join(', ');
  }
  let canForward=Boolean(media || (typeof content.conversation==='string' && content.conversation.trim()) || (typeof content.extendedTextMessage?.text==='string' && content.extendedTextMessage.text.trim()));
  viewOnce=Boolean(media && (viewOnce || media.viewOnce===true || raw.key?.isViewOnce===true));
  const canDelete=canForward || poll;
  if(viewOnce) {
    text=({audio:'Áudio',image:'Foto',video:'Vídeo'}[type] || 'Mídia')+' de visualização única';
    type='view_once';media=null;canForward=false;
  }
  // Tipos sem conteúdo para o cliente (protocolo, chaves, etc.) viram "system": nunca são respondidos como texto.
  if(!text && !media && type==='text' && raw.messageType && raw.messageType!=='conversation' && raw.messageType!=='extendedTextMessage') {type='system';text='['+raw.messageType+']';}
  let timestamp=Number(raw.messageTimestamp?.low ?? raw.messageTimestamp ?? 0);if(timestamp>0 && timestamp<1e11) timestamp*=1000;
  let status=raw.MessageUpdate?.at(-1)?.status ?? raw.status ?? 'PENDING',key=raw.key || {};
  const protocol=content.protocolMessage;
  const revoke=protocol && [0,'REVOKE'].includes(protocol.type) && typeof protocol.key?.id==='string' && (!protocol.key.remoteJid || protocol.key.remoteJid===key.remoteJid);
  const deleted=key.deleted===true || raw.status==='DELETED' || raw.MessageUpdate?.some(update=>update.status==='DELETED') || revoke;
  if(revoke) key={...protocol.key,remoteJid:key.remoteJid};
  const edited=!deleted && (raw.status==='EDITED' || raw.MessageUpdate?.some?.(update=>update.status==='EDITED')===true);
  if(deleted) {type='deleted';text='Mensagem apagada';media=null;canForward=false;status='DELETED';reaction=null;location=null;contacts=null;}
  const expiration=Number(media?.contextInfo?.expiration ?? content.extendedTextMessage?.contextInfo?.expiration ?? content.messageContextInfo?.expiration ?? raw.contextInfo?.expiration);
  if(Number.isInteger(expiration) && expiration>0) ephemeral=true;
  const info=raw.contextInfo || media?.contextInfo || content.extendedTextMessage?.contextInfo || place?.contextInfo || content.contactMessage?.contextInfo || null;
  const quoted=deleted || reaction?null:quotedOf(info,key.remoteJid);
  const thumbnail=['image','video'].includes(type)?jpegThumbnail(media?.jpegThumbnail):null;
  const durationSeconds=['video','audio'].includes(type) && Number.isFinite(media?.seconds) && media.seconds>=0?media.seconds:null;
  // fileLength chega como número, texto ou {low,high}; a tela usa o tamanho para não baixar sozinha um áudio grande.
  const fileLength=media?.fileLength,bytesValue=fileLength && typeof fileLength==='object'?(Number(fileLength.low)>>>0)+Number(fileLength.high || 0)*2**32:Number(fileLength);
  const bytes=type==='audio' && Number.isFinite(bytesValue) && bytesValue>0?bytesValue:null;
  // O WhatsApp aceita editar textos próprios por até 15 minutos; o conector confere de novo.
  const canEdit=key.fromMe===true && !deleted && type==='text' && (typeof content.conversation==='string' || typeof content.extendedTextMessage?.text==='string');
  const senderName=groupJid(key.remoteJid) && typeof raw.pushName==='string'?raw.pushName.trim().slice(0,160):null;
  const delivery=key.fromMe===true && !deleted?{deliveryStatus:deliveryStatusOf(raw)}:{};
  return {id:key.id || raw.id,jid:key.remoteJid,fromMe:key.fromMe===true,text:String(text),type,timestamp,status,...delivery,mimeType:media?.mimetype || null,fileName:media?.fileName || null,key,canForward,canDelete:key.fromMe===true && !deleted && Boolean(canDelete),...(senderName?{senderName}:{}),...(viewOnce && !deleted?{viewOnce:true}:{}),...(thumbnail?{jpegThumbnail:thumbnail}:{}),...(durationSeconds!==null?{durationSeconds}:{}),...(bytes!==null?{bytes}:{}),...(canEdit?{canEdit:true}:{}),...(media?.ptt===true?{voice:true}:{}),...(deleted?{deleted:true}:{}),...(edited?{edited:true}:{}),...(poll && !deleted?{poll}:{}),...(vote && !deleted?{vote}:{}),...(reaction?{reaction}:{}),...(location?{location}:{}),...(contacts?{contacts}:{}),...(quoted?{quoted}:{}),...(ephemeral?{ephemeral:true,ephemeralExpiration:Number.isInteger(expiration) && expiration>0?expiration:null}:{})};
}
// Valores aceitos pelo WhatsApp (Evolution 2.3.7) para cada opção de privacidade.
const PRIVACY={readreceipts:['all','none'],profile:['all','contacts','contact_blacklist','none'],status:['all','contacts','contact_blacklist','none'],online:['all','match_last_seen'],last:['all','contacts','contact_blacklist','none'],groupadd:['all','contacts','contact_blacklist','none']};
function createEvolutionClient(config={},fetchImpl=fetch) {
  let base;
  try {base=new URL(config.apiUrl);}catch{throw new ApiError('Configuração local ausente. Abra Iniciar WhatsApp Local.cmd.',503);}
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
      const text=Buffer.concat(chunks).toString('utf8');
      // Envios e alterações mudam a lista de conversas: a próxima consulta busca as conversas recentes.
      if(method!=='GET' && /^\/(message\/|chat\/(markMessageAsRead|deleteMessageForEveryone|updateMessage|archiveChat|markChatUnread|updateEphemeral)\/)/.test(route)) chatsStale=true;
      return text?JSON.parse(text):{};
    } catch(error) {
      if(error instanceof ApiError) throw error;
      throw new ApiError('O conector local não respondeu. Abra Iniciar WhatsApp Local.cmd e aguarde o Docker.',503);
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
  async function rawMessage(jid,id) {
    assertJid(jid);
    if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new ApiError('Escolha uma mensagem válida.',422);
    // A mesma pessoa pode ter mensagens gravadas pelo identificador privado (@lid) e pelo número de telefone.
    for(const remoteJid of [jid,aliasCache.get(jid)].filter(Boolean)) {
      const result=await request(`/chat/findMessages/${instance}`,'POST',{where:{key:{id,remoteJid}},page:1,offset:1});
      const data=result.messages || result,records=Array.isArray(data)?data:data.records || [];
      const found=records.find(item=>item.key?.id===id && item.key?.remoteJid===remoteJid);
      if(found) return found;
    }
    throw new ApiError('A mensagem original não foi encontrada nesta conversa.',404);
  }
  async function originalMessage(jid,id) {return normalized(await rawMessage(jid,id));}
  // A citação usa a chave e o conteúdo reais da mensagem original desta conversa, nunca um texto informado pela tela.
  async function quotedFor(jid,quotedId) {
    if(quotedId===undefined || quotedId===null || quotedId==='') return {};
    const raw=await rawMessage(jid,quotedId),message=normalized(raw);
    if(message.deleted || message.type==='reaction' || message.viewOnce) throw new ApiError('Esta mensagem não pode ser respondida.',422);
    return {quoted:{key:{id:raw.key.id,remoteJid:raw.key.remoteJid,fromMe:raw.key.fromMe===true},message:raw.message}};
  }
  const confirmed=(result,label)=>{if(!result?.key?.id) throw new ApiError(`O conector não confirmou ${label}. Confira a conversa antes de tentar novamente.`);return normalizeMessage(result);};
  const typingDelay=delay=>Number.isFinite(delay) && delay>0?Math.min(Math.round(delay),60_000):0;
  const validBase64=(value,max=10*1024*1024)=>typeof value==='string' && value.length>0 && value.length%4===0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.byteLength(value,'base64')<=max;
  async function sendViewOnce(jid,input,quotedId) {
    const quote=await quotedFor(jid,quotedId);
    const result=confirmed(await request(`/chat/sendViewOnce/${instance}`,'POST',{number:jid,...input,...quote},false,60_000),'o envio de visualização única');
    if(!result.viewOnce) throw new ApiError('O conector não confirmou a visualização única.');
    return result;
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
  const cacheMs=Math.max(0,Number(config.chatsCacheMs) || 0),fullMs=Math.max(0,Number(config.chatsFullRefreshMs) || 0),RECENT_WINDOW=10*60_000;
  let archivedMap=null,archivedAt=0,archivedUnsupportedUntil=0;
  let rawChats=new Map(),chatsList=null,chatsAt=0,fullAt=0,listDirty=false,chatsPending=null,chatsStale=true,aliasCache=new Map();
  const rowsOf=result=>(Array.isArray(result)?result:result?.chats || []).filter(item=>{
    const jid=item?.remoteJid || item?.id;
    return individualJid(jid) || groupJid(jid);
  });
  let groups=new Map(),groupsPending,groupsRefreshAt=0;
  function syncGroups() {
    if(groupsPending) return groupsPending;
    if(Date.now()<groupsRefreshAt) return Promise.resolve();
    groupsPending=request(`/chat/localGroups/${instance}`).then(result=>{
      if(!Array.isArray(result.groups)) throw new ApiError('Resposta de grupos inválida.');
      groups=new Map(result.groups.filter(item=>groupJid(item?.id)).map(item=>[item.id,item.subject]));
      groupsRefreshAt=Date.now()+5*60_000;
    }).catch(()=>{groupsRefreshAt=Date.now()+30_000;}).finally(()=>{groupsPending=null;});
    return groupsPending;
  }
  function normalizeGroup(jid,item={}) {
    const subject=groups.get(jid) || item.subject || item.name;
    return {jid,isGroup:true,name:typeof subject==='string' && subject.trim()?subject.trim():'Grupo '+jid.split('@')[0],
      unread:Math.max(0,Number(item.unreadCount)||0),lastMessage:item.lastMessage?normalized(item.lastMessage):null};
  }
  function normalizeChat(item,aliases) {
    const jid=item.remoteJid || item.id,alias=aliases.get(jid);
    const records=[contactsByJid.get(jid),contactsByJid.get(alias)].filter(Boolean);
    const phoneJid=jid.endsWith('@s.whatsapp.net')?jid:alias?.endsWith('@s.whatsapp.net')?alias:null;
    const phone=phoneJid?.split('@')[0];
    return {jid,aliasJids:alias?[alias]:[],...(preferredName(records,item) || {name:phone || jid.split('@')[0],nameSource:'number'}),...(phone?{phone}:{}),unread:Math.max(0,Number(item.unreadCount)||0),lastMessage:item.lastMessage?normalized(item.lastMessage):null};
  }
  function buildChats() {const rows=[...rawChats.values()].filter(item=>individualJid(item.remoteJid || item.id));aliasCache=contactAliases(contacts,rows);chatsList=rows.map(item=>normalizeChat(item,aliasCache));listDirty=false;return chatsList;}
  async function refreshChats() {
    const started=Date.now(),full=!fullAt || fullMs<=0 || started-fullAt>=fullMs || !chatsAt;
    const query=full?{}:{where:{messageTimestamp:{gte:new Date(chatsAt-RECENT_WINDOW).toISOString(),lte:new Date(started+5*60_000).toISOString()}}};
    const [result]=await Promise.all([request(`/chat/findChats/${instance}`,'POST',query),syncContacts()]),rows=rowsOf(result);
    // Conversas atualizadas vão para o início, como na ordem da Evolution (mais recentes primeiro).
    const next=new Map(rows.map(row=>[row.remoteJid || row.id,row]));
    if(!full) for(const [jid,row] of rawChats) if(!next.has(jid)) next.set(jid,row);
    rawChats=next;if(full) fullAt=started;chatsAt=started;chatsStale=false;
    return buildChats();
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
        if(!state.exists) await request('/instance/create','POST',{instanceName:config.instanceName,integration:'WHATSAPP-BAILEYS',qrcode:true,syncFullHistory:false,groupsIgnore:false,readMessages:false,readStatus:false,alwaysOnline:false});
        const result=await request(`/instance/connect/${instance}`),raw=result.base64 || result.qrcode?.base64;
        const base64=typeof raw==='string'?(raw.startsWith('data:image/png;base64,')?raw:`data:image/png;base64,${raw}`):null;
        if(base64 && !/^data:image\/png;base64,[a-zA-Z0-9+/=\r\n]+$/.test(base64)) throw new ApiError('QR Code inválido recebido do conector.');
        return {state:'connecting',base64,count:result.count ?? 0};
      })().finally(()=>{connecting=null;});
      return connecting;
    },
    disconnect:()=>request(`/instance/logout/${instance}`,'DELETE'),
    // Remove só esta instância do conector; uma instância que nunca foi pareada já não existe.
    async remove() {
      try {await request(`/instance/delete/${instance}`,'DELETE');}
      catch(error) {if(error.status!==404) throw error;}
    },
    // Lista compartilhada por todos os módulos e pela tela. Com cache ligado, uma listagem completa a cada `chatsFullRefreshMs`
    // e, no intervalo, só as conversas com mensagens recentes (a consulta da Evolution percorre todas as mensagens).
    async chats({maxAge=cacheMs}={}) {
      if(cacheMs>0 && chatsList && !chatsStale && Date.now()-chatsAt<maxAge) {if(listDirty) buildChats();return chatsList.slice();}
      if(cacheMs<=0) return (await refreshChats()).slice();
      if(!chatsPending) chatsPending=refreshChats().finally(()=>{chatsPending=null;});
      return (await chatsPending).slice();
    },
    async inboxChats() {
      const [individualChats]=await Promise.all([this.chats(),syncGroups()]);
      const groupIds=new Set([...groups.keys(),...[...rawChats.keys()].filter(groupJid)]);
      return [...individualChats,...[...groupIds].map(jid=>normalizeGroup(jid,rawChats.get(jid)))];
    },
    async chatLists() {
      const result=await request(`/chat/localLists/${instance}`,'GET',undefined,false,90_000);
      if(!Array.isArray(result.lists)) throw new ApiError('Resposta de listas inválida.');
      return result.lists;
    },
    // Estado atual de uma conversa só, para conferir antes de enviar sem baixar a lista inteira.
    async chat(jid) {
      assertJid(jid);
      const row=rowsOf(await request(`/chat/findChats/${instance}`,'POST',{where:{remoteJid:jid}})).find(item=>(item.remoteJid || item.id)===jid);
      if(!row) return null;
      const next=new Map([[jid,row]]);for(const [key,value] of rawChats) if(key!==jid) next.set(key,value);rawChats=next;listDirty=true;
      const alias=aliasCache.get(jid) ?? contactAliases(contacts,[row]).get(jid);
      return normalizeChat(row,new Map(alias?[[jid,alias]]:[]));
    },
    invalidateChats() {chatsStale=true;archivedAt=0;},
    // Arquivadas informadas pelo WhatsApp (extensão local). null quando a extensão não está instalada.
    async archivedState({maxAge=15_000}={}) {
      if(Date.now()<archivedUnsupportedUntil) return archivedMap;
      if(archivedMap && Date.now()-archivedAt<maxAge) return archivedMap;
      try {
        const result=await request(`/chat/localArchived/${instance}`);
        if(result?.archiveSync!==true || !result.chats || typeof result.chats!=='object') throw new ApiError('Resposta de arquivadas inválida.');
        const map=new Map();
        for(const [jid,item] of Object.entries(result.chats)) if(individualJid(jid) && typeof item?.archived==='boolean' && Number.isFinite(item.updatedAt)) map.set(jid,{archived:item.archived,updatedAt:item.updatedAt,...(Number.isFinite(item.lastMessageAt)?{lastMessageAt:item.lastMessageAt}:{}),...(individualJid(item.alias)?{alias:item.alias}:{})});
        // snapshot: a extensão sabe ler as arquivadas antigas; snapshotAt: quando leu pela última vez.
        map.meta={snapshot:result.snapshot===true,snapshotAt:Number.isFinite(result.snapshotAt)?result.snapshotAt:null,unarchiveChats:typeof result.unarchiveChats==='boolean'?result.unarchiveChats:null};
        archivedMap=map;archivedAt=Date.now();return map;
      } catch(error) {if(error.status===404) archivedUnsupportedUntil=Date.now()+5*60_000;return archivedMap;}
    },
    // Lê no WhatsApp todas as conversas arquivadas, inclusive as anteriores à extensão (somente leitura).
    async archiveSnapshot() {
      try {
        const result=await request(`/chat/localArchivedSnapshot/${instance}`,'POST',{},false,150_000);
        if(result?.success===false) {
          const detail=typeof result.detail==='string' && result.detail?` (motivo informado: ${result.detail.slice(0,160)})`:'';
          throw Object.assign(new ApiError(`${String(result.error || 'O WhatsApp não respondeu à leitura das arquivadas.').slice(0,300)}${detail}`,result.reason==='missing-key'?409:502),{fromExtension:true});
        }
        archivedAt=0;archivedUnsupportedUntil=0;
        return {archived:Number(result?.archived) || 0,lid:Number(result?.lid) || 0,linked:Number(result?.linked) || 0,changed:Number(result?.changed) || 0,partial:result?.partial===true,snapshotAt:Number(result?.snapshotAt) || Date.now()};
      } catch(error) {
        if(error.status===404) throw new ApiError('A Evolution em execução ainda não sabe ler as arquivadas antigas. Abra “Iniciar WhatsApp Local.cmd” para atualizá-la.',409);
        if(error.fromExtension) throw error;
        throw new ApiError('O WhatsApp não respondeu à leitura das arquivadas. Confira se ele está conectado e tente de novo em alguns minutos.',502);
      }
    },
    // Agenda do WhatsApp em uma entrada por pessoa (telefone e identificador privado unificados quando o vínculo é seguro).
    async contactsList() {
      await syncContacts();
      const aliases=contactAliases(contacts,[...rawChats.values()]),seen=new Set(),result=[];
      for(const record of contacts) {
        const jid=record.remoteJid;if(!individualJid(jid)) continue;
        const alias=aliases.get(jid),key=[jid,alias].filter(Boolean).sort().join('|');if(seen.has(key)) continue;seen.add(key);
        const records=[record,contactsByJid.get(alias)].filter(Boolean),phoneJid=jid.endsWith('@s.whatsapp.net')?jid:alias?.endsWith('@s.whatsapp.net')?alias:null,main=phoneJid || jid;
        result.push({jid:main,aliasJids:[jid,alias].filter(id=>id && id!==main),...(preferredName(records) || {name:phoneJid?.split('@')[0] || jid.split('@')[0],nameSource:'number'}),phone:phoneJid?.split('@')[0] || null});
      }
      return result;
    },
    chatsCacheInfo:()=>({cached:rawChats.size,at:chatsAt || null,fullAt:fullAt || null,cacheMs,fullRefreshMs:fullMs}),
    message:originalMessage,
    async deleteMessage(jid,id) {
      const message=await originalMessage(jid,id);
      if(!message.canDelete) throw new ApiError('Só é possível apagar para todos uma mensagem enviada por você e disponível nesta conversa.',422);
      const result=await request(`/chat/deleteMessageForEveryone/${instance}`,'DELETE',{id:message.id,remoteJid:message.jid,fromMe:true});
      const protocol=result.message?.protocolMessage;
      if(!result.key?.id || ![0,'REVOKE'].includes(protocol?.type) || protocol.key?.id!==id || (protocol.key.remoteJid && protocol.key.remoteJid!==message.jid)) throw new ApiError('O conector não confirmou que a mensagem foi apagada. Confira a conversa no celular antes de tentar novamente.');
      rememberDeleted({...message,deleted:true});return {id,jid,deleted:true,scope:'everyone'};
    },
    async messages(jid,page=1) {
      assertConversationJid(jid);
      // Conversa com dois identificadores (@lid e número): as mensagens dos dois aparecem juntas, página a página.
      const results=await Promise.all([jid,aliasCache.get(jid)].filter(Boolean).map(remoteJid=>request(`/chat/findMessages/${instance}`,'POST',{where:{key:{remoteJid}},page,offset:50})));
      const records=[],data={currentPage:0,pages:1,total:0};
      for(const result of results) {
        const part=result.messages || result,rows=Array.isArray(part)?part:part.records || [];records.push(...(groupJid(jid)?rows.filter(row=>row.key?.remoteJid===jid):rows));
        data.total+=Number(part.total)||rows.length;data.pages=Math.max(data.pages,Number(part.pages)||1);data.currentPage ||= Number(part.currentPage)||0;
      }
      const messages=records.map(normalizeMessage);messages.forEach(rememberDeleted);
      const unique=new Map();
      for(const raw of records) {
        const message=normalized(raw),previous=unique.get(message.id);
        if(previous && !message.timestamp) message.timestamp=previous.timestamp;
        if(message.deliveryStatus && previous?.deliveryStatus && deliveryStates.indexOf(previous.deliveryStatus)>deliveryStates.indexOf(message.deliveryStatus)) message.deliveryStatus=previous.deliveryStatus;
        if(!previous || message.deleted || !previous.deleted) unique.set(message.id,message);
      }
      return {messages:[...unique.values()].sort((a,b)=>a.timestamp-b.timestamp),page:Number(data.currentPage)||page,pages:Number(data.pages)||1,total:Number(data.total)||records.length};
    },
    // `delay` (ms) mostra "digitando…" no WhatsApp do contato por esse tempo antes de enviar.
    async sendText(jid,text,{delay=0,quotedId}={}) {
      const typing=typingDelay(delay),quote=await quotedFor(assertJid(jid),quotedId);
      const result=await request(`/message/sendText/${instance}`,'POST',{number:jid,text,linkPreview:false,...(typing?{delay:typing}:{}),...quote},false,typing);
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio. Confira a conversa antes de tentar novamente.');
      return normalizeMessage(result);
    },
    async sendMedia(jid,input) {
      if(input.viewOnce) return sendViewOnce(assertJid(jid),{mediatype:input.mediaType,media:input.base64,mimetype:input.mimeType,fileName:input.fileName,caption:input.caption || ''},input.quotedId);
      const quote=await quotedFor(assertJid(jid),input.quotedId);
      const result=await request(`/message/sendMedia/${instance}`,'POST',{number:jid,mediatype:input.mediaType,mimetype:input.mimeType,fileName:input.fileName,media:input.base64,caption:input.caption || '',...quote});
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio do anexo.');return normalizeMessage(result);
    },
    // Mensagem de voz (PTT): o conector converte para OGG/Opus e mostra "gravando áudio…" durante `delay`.
    async sendVoice(jid,{base64,delay=0,quotedId,viewOnce=false}={}) {
      assertJid(jid);if(!validBase64(base64)) throw new ApiError('Áudio inválido. Envie um áudio de até 10 MB.',422);
      if(viewOnce) return sendViewOnce(jid,{mediatype:'audio',media:base64},quotedId);
      const typing=typingDelay(delay),quote=await quotedFor(jid,quotedId);
      return confirmed(await request(`/message/sendWhatsAppAudio/${instance}`,'POST',{number:jid,audio:base64,encoding:true,...(typing?{delay:typing}:{}),...quote},false,typing+60_000),'o envio do áudio');
    },
    async sendLocation(jid,input={}) {
      assertJid(jid);
      const latitude=Number(input.latitude),longitude=Number(input.longitude);
      if(!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude<-90 || latitude>90 || longitude<-180 || longitude>180) throw new ApiError('Informe uma latitude entre -90 e 90 e uma longitude entre -180 e 180.',422);
      const text=(value,max)=>typeof value==='string' && value.trim()?value.trim().slice(0,max):undefined;
      const quote=await quotedFor(jid,input.quotedId);
      return confirmed(await request(`/message/sendLocation/${instance}`,'POST',{number:jid,latitude,longitude,...(text(input.name,200)?{name:text(input.name,200)}:{}),...(text(input.address,300)?{address:text(input.address,300)}:{}),...quote}),'o envio da localização');
    },
    async sendContact(jid,input={}) {
      assertJid(jid);
      const fullName=typeof input.fullName==='string'?input.fullName.trim():'';
      if(!fullName || fullName.length>120 || /[\r\n;:]/.test(fullName)) throw new ApiError('Informe o nome do contato (até 120 caracteres, sem ; ou :).',422);
      const number=normalizePhone(String(input.phone || ''));
      const optional=(value,max,pattern)=>typeof value==='string' && value.trim() && value.trim().length<=max && pattern.test(value.trim())?value.trim():undefined;
      const card={fullName,wuid:number,phoneNumber:'+'+number,...(optional(input.organization,120,/^[^\r\n;:]+$/)?{organization:input.organization.trim()}:{}),...(optional(input.email,254,/^[^\s@;:]+@[^\s@;:]+\.[^\s@;:]+$/)?{email:input.email.trim()}:{})};
      return confirmed(await request(`/message/sendContact/${instance}`,'POST',{number:jid,contact:[card]}),'o envio do contato');
    },
    async sendReaction(jid,id,emoji) {
      if(typeof emoji!=='string' || emoji.length>32 || /[\x00-\x1f<>]/.test(emoji) || /[A-Za-z0-9]/.test(emoji)) throw new ApiError('Escolha uma reação válida.',422);
      const message=await originalMessage(jid,id);
      if(message.deleted || message.type==='reaction') throw new ApiError('Não é possível reagir a esta mensagem.',422);
      const result=await request(`/message/sendReaction/${instance}`,'POST',{key:{id:message.id,remoteJid:message.jid,fromMe:message.fromMe},reaction:emoji});
      if(!result?.key?.id) throw new ApiError('O conector não confirmou a reação.');
      return {id:result.key.id,targetId:message.id,jid,emoji,fromMe:true};
    },
    async editMessage(jid,id,text) {
      if(typeof text!=='string' || !text.trim() || text.length>10000) throw new ApiError('Mensagem: informe de 1 a 10000 caracteres.',422);
      const message=await originalMessage(jid,id);
      if(!message.canEdit) throw new ApiError('Só é possível editar um texto enviado por você.',422);
      if(message.timestamp && Date.now()-message.timestamp>15*60_000) throw new ApiError('O WhatsApp só permite editar mensagens enviadas há até 15 minutos.',422);
      const result=await request(`/chat/updateMessage/${instance}`,'POST',{number:message.jid,key:{id:message.id,remoteJid:message.jid,fromMe:true},text:text.trim()});
      const protocol=result?.message?.protocolMessage || result?.message?.editedMessage?.message?.protocolMessage;
      if(!result?.key?.id || (protocol?.key?.id && protocol.key.id!==id)) throw new ApiError('O conector não confirmou a edição. Confira a conversa no celular.');
      return {id,jid,text:text.trim(),edited:true};
    },
    async presence(jid,presence,delay=3000) {
      assertJid(jid);
      if(!['composing','recording','paused'].includes(presence)) throw new ApiError('Presença inválida.',422);
      const wait=Math.max(0,Math.min(Number(delay) || 0,10_000));
      await request(`/chat/sendPresence/${instance}`,'POST',{number:jid,presence,delay:wait},false,wait);
      return {jid,presence};
    },
    async archiveChat(jid,archive) {
      assertJid(jid);if(typeof archive!=='boolean') throw new ApiError('Escolha arquivar ou desarquivar.',422);
      const result=await request(`/chat/archiveChat/${instance}`,'POST',{chat:jid,archive});
      if(result?.archived!==true) throw new ApiError('O conector não confirmou o arquivamento.');
      return {jid,archived:archive};
    },
    async markChatUnread(jid) {
      assertJid(jid);const result=await request(`/chat/markChatUnread/${instance}`,'POST',{chat:jid});
      if(result?.markedChatUnread!==true) throw new ApiError('O conector não confirmou a marcação como não lida.');
      return {jid,markedUnread:true};
    },
    async blockContact(jid,block) {
      assertJid(jid);if(typeof block!=='boolean') throw new ApiError('Escolha bloquear ou desbloquear.',422);
      const result=await request(`/chat/updateBlockStatus/${instance}`,'POST',{number:jid,status:block?'block':'unblock'});
      if(result?.block!=='success') throw new ApiError('O conector não confirmou o bloqueio. Confira no celular.');
      return {jid,blocked:block};
    },
    async ownProfile() {
      const state=await connection();if(state.state!=='connected' || !state.phone) throw new ApiError('Conecte o WhatsApp para ver o seu perfil.',409);
      const [profile,picture]=await Promise.all([request(`/chat/fetchProfile/${instance}`,'POST',{number:state.phone}).catch(()=>null),request(`/chat/fetchProfilePictureUrl/${instance}`,'POST',{number:state.phone}).catch(()=>null)]);
      const url=typeof picture?.profilePictureUrl==='string' && /^https:\/\//.test(picture.profilePictureUrl)?picture.profilePictureUrl:null;
      return {phone:state.phone,name:typeof profile?.name==='string'?profile.name.slice(0,100):null,about:typeof profile?.status==='string'?profile.status.slice(0,500):null,pictureUrl:url,isBusiness:profile?.isBusiness===true};
    },
    async updateProfileName(name) {
      if(typeof name!=='string' || !name.trim() || name.trim().length>25) throw new ApiError('Seu nome pode ter de 1 a 25 caracteres.',422);
      const result=await request(`/chat/updateProfileName/${instance}`,'POST',{name:name.trim()});
      if(result?.update!=='success') throw new ApiError('O conector não confirmou a alteração do nome.');return {name:name.trim()};
    },
    async updateProfileAbout(status) {
      if(typeof status!=='string' || !status.trim() || status.trim().length>139) throw new ApiError('O recado pode ter de 1 a 139 caracteres.',422);
      const result=await request(`/chat/updateProfileStatus/${instance}`,'POST',{status:status.trim()});
      if(result?.update!=='success') throw new ApiError('O conector não confirmou a alteração do recado.');return {about:status.trim()};
    },
    async updateProfilePicture(base64) {
      if(!validBase64(base64,5*1024*1024)) throw new ApiError('Envie uma foto JPG ou PNG de até 5 MB.',422);
      const result=await request(`/chat/updateProfilePicture/${instance}`,'POST',{picture:base64});
      if(result?.update!=='success') throw new ApiError('O conector não confirmou a nova foto.');return {updated:true};
    },
    async removeProfilePicture() {
      const result=await request(`/chat/removeProfilePicture/${instance}`,'DELETE',{});
      if(result?.update!=='success') throw new ApiError('O conector não confirmou a remoção da foto.');return {removed:true};
    },
    async privacySettings() {
      const result=await request(`/chat/fetchPrivacySettings/${instance}`);
      return Object.fromEntries(Object.keys(PRIVACY).map(key=>[key,PRIVACY[key].includes(result?.[key])?result[key]:null]));
    },
    async updatePrivacySettings(input={}) {
      const current=await this.privacySettings(),next={};
      for(const [key,values] of Object.entries(PRIVACY)) {
        const value=input[key]===undefined?current[key]:input[key];
        if(!values.includes(value)) throw new ApiError('Escolha opções de privacidade válidas.',422);next[key]=value;
      }
      const result=await request(`/chat/updatePrivacySettings/${instance}`,'POST',next);
      if(result?.update!=='success') throw new ApiError('O conector não confirmou a privacidade.');return next;
    },
    async sendSticker(jid,input) {
      assertJid(jid);
      if(typeof input?.base64!=='string' || !input.base64 || input.base64.length>14_000_000 || input.base64.length%4!==0 || Buffer.byteLength(input.base64,'base64')>10*1024*1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new ApiError('Figurinha inválida. Envie uma imagem de até 10 MB.',422);
      const quote=await quotedFor(jid,input.quotedId);
      const result=await request(`/message/sendSticker/${instance}`,'POST',{number:jid,sticker:input.base64,...quote});
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
    // A mídia de uma mensagem gravada pelo outro identificador da mesma pessoa também é encontrada.
    async media(jid,id) {
      const load=remoteJid=>request(`/chat/getBase64FromMediaMessage/${instance}`,'POST',{message:{key:{id,remoteJid}}},true);
      const alias=aliasCache.get(assertConversationJid(jid));
      try {return await load(jid);}catch(error) {if(!alias) throw error;return load(alias);}
    },
    profile:jid=>request(`/chat/fetchProfilePictureUrl/${instance}`,'POST',{number:assertJid(jid)}),
    async resolvePhone(phone) {
      const number=normalizePhone(phone),result=await request(`/chat/whatsappNumbers/${instance}`,'POST',{numbers:[number]});
      const record=(Array.isArray(result)?result:result.numbers || [])[0];
      if(!record?.exists) throw new ApiError('Este número não foi encontrado no WhatsApp.',422);
      return {jid:assertJid(record.jid || number+'@s.whatsapp.net'),name:record.name || number};
    }
  };
}
module.exports={createEvolutionClient,ApiError,assertJid,assertConversationJid,groupJid,normalizePhone,normalizeMessage,vcardPhones,PRIVACY};
