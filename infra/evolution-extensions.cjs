// Local extension by Codex, 2026-10-29. Evolution API 2.3.7 / Baileys 7.0.0-rc.9.
// Adds authenticated individual-chat timer settings and inherits confirmed timers on sends.
const fs=require('node:fs');
const crypto=require('node:crypto');
const vm=require('node:vm');
const MAIN_SHA256='71b49ea87b8d0d7b413b77d067e33a8720c2e95e136f632210c1424862ef6b44';
const STORE='/evolution/instances/whatsapp-central-disappearing.v1.json';
const individual=value=>typeof value==='string' && /^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/.test(value);
const expirationValid=value=>[0,86400,604800,7776000].includes(value);
function createExtension(storage={}) {
  const load=storage.load || (()=>{try {const stat=fs.statSync(STORE);if(stat.size>2_000_000) throw new Error('Timer store too large');return JSON.parse(fs.readFileSync(STORE,'utf8'));}catch(error) {if(error.code==='ENOENT') return {};throw error;}});
  const save=storage.save || (value=>{const temporary=STORE+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,STORE);});
  let state;
  const listening=new WeakSet();
  function current() {if(!state) {const loaded=load();if(!loaded || typeof loaded!=='object' || Array.isArray(loaded)) throw new Error('Invalid timer store');state=loaded;}return state;}
  function instanceKey(service) {const id=service?.instanceId || service?.instance?.id;return typeof id==='string' && id?id:null;}
  function canonicalJid(service,jid) {
    const id=instanceKey(service),entry=id?current()[id]?.[jid]:null;
    return individual(entry?.canonicalJid)?entry.canonicalJid:jid;
  }
  function timer(service,jid) {
    const id=instanceKey(service),entry=id?current()[id]?.[canonicalJid(service,jid)]:null;
    return entry && expirationValid(entry.expiration) && Number.isFinite(entry.updatedAt)?entry:null;
  }
  function remember(service,jid,expiration,updatedAt,source,canonical) {
    const id=instanceKey(service);if(!id || !individual(jid) || !expirationValid(expiration) || !Number.isFinite(updatedAt)) return;
    const previous=timer(service,jid);if(source!=='central' && previous && previous.updatedAt>updatedAt) return;
    const target=individual(canonical)?canonical:canonicalJid(service,jid);
    const next={...current(),[id]:{...current()[id],[target]:{expiration,updatedAt,source},...(target!==jid?{[jid]:{canonicalJid:target}}:{})}};
    save(next);state=next;
  }
  function observe(service) {
    const socket=service?.client;if(!socket || typeof socket!=='object' || listening.has(socket) || typeof socket.ev?.on!=='function') return;
    listening.add(socket);
    socket.ev.on('messages.upsert',payload=>{
      for(const message of Array.isArray(payload?.messages)?payload.messages:[]) {
        let content=message.message;
        for(let n=0;n<4 && content?.ephemeralMessage?.message;n++) content=content.ephemeralMessage.message;
        const protocol=content?.protocolMessage,timestamp=Number(message.messageTimestamp?.low ?? message.messageTimestamp);
        if([3,'EPHEMERAL_SETTING'].includes(protocol?.type)) {
          try {remember(service,message.key?.remoteJid,protocol.ephemeralExpiration,timestamp*1000,'whatsapp');}catch { /* keep the last durable timer; never leak connector diagnostics */ }
        }
      }
    });
    socket.ev.on('chats.update',updates=>{
      for(const chat of Array.isArray(updates)?updates:[]) {
        if(!expirationValid(chat.ephemeralExpiration)) continue;
        const timestamp=Number(chat.ephemeralSettingTimestamp?.low ?? chat.ephemeralSettingTimestamp);
        if(Number.isFinite(timestamp)) {try {remember(service,chat.id,chat.ephemeralExpiration,timestamp*1000,'whatsapp');}catch {}}
      }
    });
  }
  function expirationFor(service,jid) {observe(service);return individual(jid)?timer(service,jid)?.expiration:undefined;}
  function serviceFor(controller,request) {return controller?.waMonitor?.waInstances?.[request.params?.instanceName];}
  const fail=(response,status,message)=>response.status(status).json({error:message});
  function capabilityHandler(controller) {return async(request,response)=>{
    const service=serviceFor(controller,request),supported=typeof service?.client?.sendMessage==='function' && Boolean(instanceKey(service));
    const jid=request.query?.number;
    if(jid!==undefined && !individual(jid)) return fail(response,422,'Escolha uma conversa individual válida.');
    try {observe(service);const setting=jid?timer(service,jid):null;return response.status(200).json({extensionVersion:1,disappearingMessages:supported,...(setting?{expiration:setting.expiration,updatedAt:setting.updatedAt,source:setting.source}:{expiration:null})});}
    catch {return fail(response,503,'Não foi possível ler a configuração de mensagens temporárias.');}
  };}
  function ephemeralHandler(controller) {return async(request,response)=>{
    const {number,expiration}=request.body || {};
    if(!individual(number) || !expirationValid(expiration)) return fail(response,422,'Escolha uma conversa individual e um prazo válido.');
    const service=serviceFor(controller,request);
    if(typeof service?.client?.sendMessage!=='function' || !instanceKey(service)) return fail(response,503,'O WhatsApp precisa estar conectado.');
    try {
      // Read durable state before the send so corrupt/unwritable configuration cannot be ignored.
      current();observe(service);
      const matches=typeof service.whatsappNumber==='function'?await service.whatsappNumber({numbers:[number]}):null;
      const resolved=Array.isArray(matches)?matches.find(item=>item.number===number && item.exists===true && individual(item.jid)):null;
      if(matches && !resolved) return fail(response,422,'Esta conversa não está disponível no WhatsApp.');
      const target=resolved?.jid || number;
      const result=await service.client.sendMessage(target,{disappearingMessagesInChat:expiration});
      const protocol=result?.message?.ephemeralMessage?.message?.protocolMessage || result?.message?.protocolMessage;
      if(!result?.key?.id || (result.key.remoteJid && result.key.remoteJid!==target) || ![3,'EPHEMERAL_SETTING'].includes(protocol?.type) || protocol.ephemeralExpiration!==expiration) return fail(response,502,'O WhatsApp não confirmou a alteração. Confira a conversa no celular.');
      const updatedAt=Date.now();remember(service,number,expiration,updatedAt,'central',target);
      return response.status(200).json({success:true,jid:number,expiration,updatedAt,source:'central'});
    } catch {return fail(response,502,'Não foi possível confirmar a alteração. Confira a conversa no celular antes de tentar novamente.');}
  };}
  return {expirationFor,capabilityHandler,ephemeralHandler,observe};
}
function patchBundle(source,version) {
  if(version!=='2.3.7') throw new Error('Unsupported Evolution version; expected 2.3.7.');
  if(crypto.createHash('sha256').update(source).digest('hex')!==MAIN_SHA256) throw new Error('Evolution bundle hash mismatch; refusing to patch unknown code.');
  const route='.delete(this.routerPath("deleteMessageForEveryone"),...e,async(t,o)=>';
  const send='l=await this.sendMessage(r,t,u,a,c,null,void 0,m)';
  const events='eventHandler(){this.client.ev.process(';
  if([route,send,events].some(anchor=>source.split(anchor).length!==2)) throw new Error('Evolution extension patch anchors must each occur exactly once.');
  const extension='require("/evolution/local/evolution-extensions.cjs")';
  const patched=source.replace(route,`.get(this.routerPath("localCapabilities"),...e,${extension}.capabilityHandler(Y)).post(this.routerPath("updateEphemeral"),...e,${extension}.ephemeralHandler(Y))`+route).replace(send,`l=await this.sendMessage(r,t,u,a,c,null,${extension}.expirationFor(this,r),m)`).replace(events,`eventHandler(){${extension}.observe(this);this.client.ev.process(`);
  new vm.Script(patched,{filename:'evolution-patched-main.js'});
  return patched;
}
const extension=createExtension();
module.exports={...extension,createExtension,patchBundle};
if(require.main===module) {
  if(process.argv[2]!=='--patch') throw new Error('Use --patch during the image build.');
  const version=JSON.parse(fs.readFileSync('/evolution/package.json','utf8')).version;
  const path='/evolution/dist/main.js',original=fs.readFileSync(path,'utf8');
  const patched=patchBundle(original,version);fs.writeFileSync(path,patched);
  process.stdout.write('Verified Evolution 2.3.7 extension: authenticated timers and send inheritance installed.\n');
}
