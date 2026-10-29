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
  let content=raw.message || {};
  for(let n=0;n<4;n++) {
    const nested=content.ephemeralMessage?.message || content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content.documentWithCaptionMessage?.message;
    if(!nested) break;content=nested;
  }
  let type='text',text=content.conversation ?? content.extendedTextMessage?.text ?? '',media=null;
  for(const [key,kind] of [['imageMessage','image'],['videoMessage','video'],['audioMessage','audio'],['documentMessage','document'],['stickerMessage','sticker']]) {
    if(content[key]) {type=kind;media=content[key];text=media.caption || media.fileName || '';break;}
  }
  const canForward=Boolean(media || (typeof content.conversation==='string' && content.conversation.trim()) || (typeof content.extendedTextMessage?.text==='string' && content.extendedTextMessage.text.trim()));
  if(!text && !media) text=content.contactMessage?.displayName || content.locationMessage?.name || (raw.messageType && raw.messageType!=='conversation'?'['+raw.messageType+']':'');
  let timestamp=Number(raw.messageTimestamp?.low ?? raw.messageTimestamp ?? 0);if(timestamp>0 && timestamp<1e11) timestamp*=1000;
  const status=raw.MessageUpdate?.at(-1)?.status ?? raw.status ?? 'PENDING';
  return {id:raw.key?.id || raw.id,jid:raw.key?.remoteJid,fromMe:raw.key?.fromMe===true,text:String(text),type,timestamp,status,mimeType:media?.mimetype || null,fileName:media?.fileName || null,key:raw.key || {},canForward};
}
function createEvolutionClient(config={},fetchImpl=fetch) {
  let base;
  try {base=new URL(config.apiUrl);}catch{throw new ApiError('Configuração local ausente. Abra Iniciar WhatsApp.cmd.',503);}
  if(!['http:','https:'].includes(base.protocol) || base.username || base.password || (base.protocol==='http:' && !['127.0.0.1','localhost','[::1]'].includes(base.hostname))) throw new ApiError('Endereço do conector inválido.',503);
  if(!config.apiKey || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.instanceName || '')) throw new ApiError('Configuração da instância inválida.',503);
  const instance=encodeURIComponent(config.instanceName);
  async function request(route,method='GET',input) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20_000);
    try {
      const response=await fetchImpl(new URL(route,base),{method,signal:controller.signal,headers:{apikey:config.apiKey,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
      if(!response.ok) {await response.body?.cancel();throw new ApiError(`O conector respondeu com erro ${response.status}.`,response.status===404?404:502);}
      let length=0;const chunks=[];
      for await(const chunk of response.body || []) {length+=chunk.length;if(length>16_000_000) {controller.abort();throw new ApiError('Resposta do conector excede o limite.');}chunks.push(chunk);}
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
        return {jid,...(preferredName(records,item) || {name:phone || jid.split('@')[0],nameSource:'number'}),...(phone?{phone}:{}),unread:Math.max(0,Number(item.unreadCount)||0),lastMessage:item.lastMessage?normalizeMessage(item.lastMessage):null};
      });
    },
    async message(jid,id) {
      assertJid(jid);
      if(typeof id!=='string' || !id.trim() || id.length>200) throw new ApiError('Escolha uma mensagem válida.',422);
      const result=await request(`/chat/findMessages/${instance}`,'POST',{where:{key:{id,remoteJid:jid}},page:1,offset:1});
      const data=result.messages || result,records=Array.isArray(data)?data:data.records || [];
      const found=records.find(item=>item.key?.id===id && item.key?.remoteJid===jid);
      if(!found) throw new ApiError('A mensagem original não foi encontrada nesta conversa.',404);
      return normalizeMessage(found);
    },
    async messages(jid,page=1) {
      assertJid(jid);
      const result=await request(`/chat/findMessages/${instance}`,'POST',{where:{key:{remoteJid:jid}},page,offset:50});
      const data=result.messages || result,records=Array.isArray(data)?data:data.records || [];
      return {messages:records.map(normalizeMessage).sort((a,b)=>a.timestamp-b.timestamp),page:Number(data.currentPage)||page,pages:Number(data.pages)||1,total:Number(data.total)||records.length};
    },
    async sendText(jid,text) {
      const result=await request(`/message/sendText/${instance}`,'POST',{number:assertJid(jid),text,linkPreview:false});
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio. Confira a conversa antes de tentar novamente.');
      return normalizeMessage(result);
    },
    async sendMedia(jid,input) {
      const result=await request(`/message/sendMedia/${instance}`,'POST',{number:assertJid(jid),mediatype:input.mediaType,mimetype:input.mimeType,fileName:input.fileName,media:input.base64,caption:input.caption || ''});
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio do anexo.');return normalizeMessage(result);
    },
    async sendSticker(jid,input) {
      const result=await request(`/message/sendSticker/${instance}`,'POST',{number:assertJid(jid),sticker:input.base64});
      if(!result.key?.id) throw new ApiError('O conector não confirmou o envio da figurinha.');return normalizeMessage(result);
    },
    read:(jid,keys)=>request(`/chat/markMessageAsRead/${instance}`,'POST',{readMessages:[...new Map(keys.map(key=>[key.id,{id:key.id,remoteJid:assertJid(jid),fromMe:false}])).values()]}),
    media:(jid,id)=>request(`/chat/getBase64FromMediaMessage/${instance}`,'POST',{message:{key:{id,remoteJid:assertJid(jid)}}}),
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
