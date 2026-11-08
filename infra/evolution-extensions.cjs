// Local extension by Codex, 2026-10-29. Evolution API 2.3.7 / Baileys 7.0.0-rc.9.
// Adds authenticated individual-chat timer settings and inherits confirmed timers on sends.
// Also keeps the archive state WhatsApp reports for each chat (Evolution 2.3.7 drops it) and serves it to the central.
// Archived chats from before the extension come from a read-only copy of WhatsApp's app state (collection regular_low):
// it never changes the session's own sync state and never emits events.
const fs=require('node:fs');
const crypto=require('node:crypto');
const vm=require('node:vm');
const MAIN_SHA256='71b49ea87b8d0d7b413b77d067e33a8720c2e95e136f632210c1424862ef6b44';
const BAILEYS_SOCKET_SHA256='d7e121951ae786d39fb729e193816515869e6ca96babf386515b54de07ef7d61';
const OFFLINE_BATCH_IDLE_MS=1500;
const STORE='/evolution/instances/whatsapp-central-disappearing.v1.json';
const ARCHIVE_STORE='/evolution/instances/whatsapp-central-archived.v1.json';
const individual=value=>typeof value==='string' && /^[1-9]\d{5,19}@(s\.whatsapp\.net|lid)$/.test(value);
const expirationValid=value=>[0,86400,604800,7776000].includes(value);
const ARCHIVE_META='$meta';
const SNAPSHOT_COLLECTION='regular_low';
const numberOf=value=>typeof value==='object' && value?(typeof value.toNumber==='function'?value.toNumber():Number(value.low)):Number(value || 0);
function isViewOnce(raw) {
  let content=raw?.message;
  if(raw?.key?.isViewOnce===true) return true;
  for(let i=0;i<5 && content;i++) {
    if(content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension ||
      ['audioMessage','imageMessage','videoMessage'].some(key=>content[key]?.viewOnce===true)) return true;
    content=content.ephemeralMessage?.message || content.documentWithCaptionMessage?.message;
  }
  return false;
}
function createExtension(storage={},archiveStorage={},runtime={}) {
  const loadBaileys=runtime.loadBaileys || (()=>import('baileys'));
  const loadArchive=archiveStorage.load || (()=>{try {const stat=fs.statSync(ARCHIVE_STORE);if(stat.size>4_000_000) return {};return JSON.parse(fs.readFileSync(ARCHIVE_STORE,'utf8'));}catch {return {};}});
  const saveArchive=archiveStorage.save || (value=>{const temporary=ARCHIVE_STORE+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,ARCHIVE_STORE);});
  let archive,archiveTimer=null;
  function archives() {if(!archive) {const loaded=loadArchive();archive=loaded && typeof loaded==='object' && !Array.isArray(loaded)?loaded:{};}return archive;}
  // A sincronização inicial pode trazer milhares de conversas: grava uma vez depois que os avisos param.
  function scheduleArchiveSave() {
    if(archiveTimer) return;
    archiveTimer=setTimeout(()=>{archiveTimer=null;try {saveArchive(archives());}catch { /* the next change tries again */ }},archiveStorage.delayMs ?? 1000);archiveTimer.unref?.();
  }
  function rememberArchive(service,jid,archived,updatedAt=Date.now(),{lastMessageAt,onlyNewer=false}={}) {
    const id=instanceKey(service);if(!id || !individual(jid) || typeof archived!=='boolean') return false;
    const chats=archives()[id] ||= {},previous=chats[jid];
    if(onlyNewer && previous && previous.updatedAt>=updatedAt) return false;
    if(!onlyNewer && previous && previous.archived===archived) return false;
    chats[jid]={archived,updatedAt,...(Number.isFinite(lastMessageAt) && lastMessageAt>0?{lastMessageAt}:{})};
    const ids=Object.keys(chats);if(ids.length>20000) for(const old of ids.sort((a,b)=>chats[a].updatedAt-chats[b].updatedAt).slice(0,ids.length-20000)) delete chats[old];
    scheduleArchiveSave();
    return true;
  }
  const archiveMeta=service=>{const id=instanceKey(service),meta=archives()[ARCHIVE_META] ||= {};return id?meta[id] ||= {}:{};};
  // "Manter conversas arquivadas" desligado = unarchiveChats true: mensagem nova tira a conversa das arquivadas.
  function unarchiveSetting(service) {
    const meta=archiveMeta(service),creds=service?.client?.authState?.creds?.accountSettings?.unarchiveChats;
    return typeof meta.unarchiveChats==='boolean'?meta.unarchiveChats:typeof creds==='boolean'?creds:null;
  }
  // O WhatsApp passou a identificar muitas conversas pelo identificador privado (@lid); a lista da central usa o telefone.
  // Grava o estado também no telefone correspondente, quando o Baileys conhece o vínculo.
  async function phoneFor(service,jid) {
    if(typeof jid!=='string' || !jid.endsWith('@lid')) return null;
    try {
      const pn=await service?.client?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      const user=typeof pn==='string'?pn.split('@')[0].split(':')[0]:'';const phone=user?user+'@s.whatsapp.net':null;
      return individual(phone)?phone:null;
    } catch {return null;}
  }
  function rememberWithPhone(service,jid,archived,updatedAt,options) {
    const changed=rememberArchive(service,jid,archived,updatedAt,options);
    phoneFor(service,jid).then(phone=>{if(phone) rememberArchive(service,phone,archived,updatedAt ?? Date.now(),options);},()=>{});
    return changed;
  }
  const archiveFrom=(service,list)=>{for(const chat of Array.isArray(list)?list:[]) if(chat && typeof chat.archived==='boolean') rememberWithPhone(service,chat.id,chat.archived);};
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
    // Arquivar e desarquivar chegam como atualização de conversa, inclusive as feitas no celular.
    socket.ev.on('chats.upsert',chats=>archiveFrom(service,chats));
    socket.ev.on('messaging-history.set',payload=>archiveFrom(service,payload?.chats));
    socket.ev.on('chats.update',updates=>{
      archiveFrom(service,updates);
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
  function viewOnceHandler(controller) {return async(request,response)=>{
    const {number,mediatype,media,mimetype,fileName,caption,quoted}=request.body || {};
    if(!individual(number) ||
      !['audio','image','video'].includes(mediatype) || typeof media!=='string' || !media ||
      media.length%4!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(media) || Buffer.byteLength(media,'base64')>10*1024*1024) {
      return fail(response,422,'Mídia de visualização única inválida.');
    }
    if(mediatype!=='audio' && (typeof mimetype!=='string' || !mimetype.startsWith(mediatype+'/') ||
      typeof fileName!=='string' || !fileName || fileName.length>200 ||
      (caption!==undefined && (typeof caption!=='string' || caption.length>4000)))) {
      return fail(response,422,'Arquivo ou legenda inválida.');
    }
    const service=serviceFor(controller,request);
    if(typeof service?.sendMessageWithTyping!=='function') return fail(response,503,'O WhatsApp precisa estar conectado.');
    try {
      let message;
      if(mediatype==='audio') {
        const audio=await service.processAudio(media);
        if(!Buffer.isBuffer(audio) || !audio.length) return fail(response,422,'Não foi possível converter o áudio.');
        message={audio,ptt:true,mimetype:'audio/ogg; codecs=opus',viewOnce:true};
      } else {
        const prepared=await service.prepareMediaMessage({mediatype,media,mimetype,fileName,caption});
        prepared.message[mediatype+'Message'].viewOnce=true;
        message={viewOnceMessage:{message:prepared.message}};
      }
      const result=await service.sendMessageWithTyping(number,message,{quoted});
      if(result?.key?.id && isViewOnce(result)) return response.status(200).json(result);
    } catch { /* O cliente precisa confirmar o resultado na conversa antes de repetir. */ }
    return fail(response,502,'O WhatsApp não confirmou o envio de visualização única.');
  };}
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
  function archivedHandler(controller) {return async(request,response)=>{
    const service=serviceFor(controller,request),id=instanceKey(service);
    if(!id) return fail(response,503,'O WhatsApp precisa estar conectado.');
    try {
      observe(service);const meta=archiveMeta(service);
      return response.status(200).json({extensionVersion:2,archiveSync:true,snapshot:true,snapshotAt:meta.snapshotAt || null,unarchiveChats:unarchiveSetting(service),chats:archives()[id] || {}});
    }
    catch {return fail(response,503,'Não foi possível ler as conversas arquivadas.');}
  };}
  // Lê do WhatsApp o estado atual de arquivar/desarquivar sem gravar nada na sessão: o mesmo pedido que o
  // Baileys faz ao sincronizar do zero, mas decodificado aqui, sem alterar a versão salva nem disparar eventos.
  async function readArchiveSnapshot(socket) {
    const {extractSyncdPatches,decodeSyncdSnapshot,decodePatches,newLTHashState,S_WHATSAPP_NET}=await loadBaileys();
    const getKey=async keyId=>(await socket.authState.keys.get('app-state-sync-key',[keyId]))?.[keyId];
    const name=SNAPSHOT_COLLECTION,mutations={};let state=null;
    for(let round=0;round<50;round++) {
      const version=state?.version || 0;
      const result=await socket.query({tag:'iq',attrs:{to:S_WHATSAPP_NET,xmlns:'w:sync:app:state',type:'set'},content:[{tag:'sync',attrs:{},content:[{tag:'collection',attrs:{name,version:String(version),return_snapshot:String(!version)}}]}]});
      const decoded=(await extractSyncdPatches(result,{}))?.[name];if(!decoded) break;
      if(decoded.snapshot) {const next=await decodeSyncdSnapshot(name,decoded.snapshot,getKey,undefined,false);state=next.state;Object.assign(mutations,next.mutationMap);}
      state ||= newLTHashState();
      if(decoded.patches?.length) {const next=await decodePatches(name,decoded.patches,state,getKey,{},undefined,undefined,false);state=next.state;Object.assign(mutations,next.mutationMap);}
      if(!decoded.hasMorePatches) break;
    }
    const chats=[];let unarchiveChats=null;
    for(const {syncAction,index} of Object.values(mutations)) {
      const [type,jid]=Array.isArray(index)?index:[],value=syncAction?.value;
      if(value?.unarchiveChatsSetting && typeof value.unarchiveChatsSetting.unarchiveChats==='boolean') unarchiveChats=value.unarchiveChatsSetting.unarchiveChats;
      const action=value?.archiveChatAction;if(type!=='archive' || !action || typeof action.archived!=='boolean') continue;
      const lastMessage=numberOf(action.messageRange?.lastMessageTimestamp);
      chats.push({jid,archived:action.archived,updatedAt:numberOf(value.timestamp) || 0,lastMessageAt:lastMessage>0?lastMessage*1000:undefined});
    }
    return {chats,unarchiveChats};
  }
  const snapshots=new Map();
  function archiveSnapshot(service) {
    const id=instanceKey(service),socket=service?.client;
    if(!id || typeof socket?.query!=='function' || typeof socket.authState?.keys?.get!=='function') return Promise.reject(Object.assign(new Error('not connected'),{status:503}));
    if(snapshots.has(id)) return snapshots.get(id);
    const job=(async()=>{
      const {chats,unarchiveChats}=await readArchiveSnapshot(socket);
      let changed=0,linked=0;
      for(const chat of chats) {
        const options={lastMessageAt:chat.lastMessageAt,onlyNewer:true};
        if(rememberArchive(service,chat.jid,chat.archived,chat.updatedAt,options)) changed++;
        const phone=await phoneFor(service,chat.jid);if(phone) {linked++;rememberArchive(service,phone,chat.archived,chat.updatedAt,options);}
      }
      const meta=archiveMeta(service);meta.snapshotAt=Date.now();if(typeof unarchiveChats==='boolean') meta.unarchiveChats=unarchiveChats;scheduleArchiveSave();
      return {archived:chats.filter(chat=>chat.archived && individual(chat.jid)).length,lid:chats.filter(chat=>chat.archived && String(chat.jid).endsWith('@lid')).length,linked,changed,snapshotAt:meta.snapshotAt,unarchiveChats:unarchiveSetting(service)};
    })().finally(()=>snapshots.delete(id));
    snapshots.set(id,job);return job;
  }
  function archiveSnapshotHandler(controller) {return async(request,response)=>{
    const service=serviceFor(controller,request);
    if(!instanceKey(service) || typeof service?.client?.query!=='function') return fail(response,503,'O WhatsApp precisa estar conectado.');
    try {observe(service);return response.status(200).json({success:true,...await archiveSnapshot(service)});}
    catch(error) {
      const missingKey=/failed to find key/i.test(String(error?.message || ''));
      return fail(response,missingKey?409:502,missingKey?'O WhatsApp ainda não enviou as chaves para ler as arquivadas deste aparelho. Aguarde alguns minutos conectado e tente de novo.':'O WhatsApp não respondeu à leitura das arquivadas. Tente novamente em instantes.');
    }
  };}
  return {expirationFor,capabilityHandler,ephemeralHandler,archivedHandler,archiveSnapshotHandler,archiveSnapshot,observe,rememberArchive,viewOnceHandler};
}
function patchBundle(source,version) {
  if(version!=='2.3.7') throw new Error('Unsupported Evolution version; expected 2.3.7.');
  if(crypto.createHash('sha256').update(source).digest('hex')!==MAIN_SHA256) throw new Error('Evolution bundle hash mismatch; refusing to patch unknown code.');
  const route='.delete(this.routerPath("deleteMessageForEveryone"),...e,async(t,o)=>';
  const send='l=await this.sendMessage(r,t,u,a,c,null,void 0,m)';
  const events='eventHandler(){this.client.ev.process(';
  const media='if(!n)throw"Message not found";for(let d of Xr)';
  if([route,send,events,media].some(anchor=>source.split(anchor).length!==2)) throw new Error('Evolution extension patch anchors must each occur exactly once.');
  const extension='require("/evolution/local/evolution-extensions.cjs")';
  const patched=source.replace(route,`.get(this.routerPath("localCapabilities"),...e,${extension}.capabilityHandler(Y)).get(this.routerPath("localArchived"),...e,${extension}.archivedHandler(Y)).post(this.routerPath("localArchivedSnapshot"),...e,${extension}.archiveSnapshotHandler(Y)).post(this.routerPath("updateEphemeral"),...e,${extension}.ephemeralHandler(Y)).post(this.routerPath("sendViewOnce"),...e,${extension}.viewOnceHandler(Y))`+route).replace(send,`l=await this.sendMessage(r,t,u,a,c,null,${extension}.expirationFor(this,r),m)`).replace(events,`eventHandler(){${extension}.observe(this);this.client.ev.process(`).replace(media,`if(${extension}.isViewOnce(n))throw"Mídia de visualização única";`+media);
  new vm.Script(patched,{filename:'evolution-patched-main.js'});
  return patched;
}
// Baileys 7.0.0-rc.9 pede só um lote de 100 itens offline (offline_batch) e nunca o seguinte.
// Com mais de 100 pendências o servidor para de entregar, inclusive as mensagens novas, e a conexão segue "open".
// O patch pede um novo lote sempre que o anterior termina, até o servidor confirmar o fim com <ib><offline/>.
function patchBaileysSocket(source,version) {
  if(version!=='7.0.0-rc.9') throw new Error('Unsupported Baileys version; expected 7.0.0-rc.9.');
  if(crypto.createHash('sha256').update(source).digest('hex')!==BAILEYS_SOCKET_SHA256) throw new Error('Baileys socket hash mismatch; refusing to patch unknown code.');
  const preview=`    ws.on('CB:ib,,offline_preview', async (node) => {
        logger.info('offline preview received', JSON.stringify(node));
        await sendNode({
            tag: 'ib',
            attrs: {},
            content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
        });
    });`;
  const done=`    ws.on('CB:ib,,offline', (node) => {
        const child = getBinaryNodeChild(node, 'offline');`;
  if([preview,done].some(anchor=>source.split(anchor).length!==2)) throw new Error('Baileys offline patch anchors must each occur exactly once.');
  const patched=source.replace(preview,`    let offlinePending=false,offlineIdle=null;
    const requestOfflineBatch=()=>sendNode({tag:'ib',attrs:{},content:[{tag:'offline_batch',attrs:{count:'100'}}]});
    const scheduleOfflineBatch=()=>{clearTimeout(offlineIdle);if(!offlinePending) return;offlineIdle=setTimeout(()=>{if(offlinePending) requestOfflineBatch().catch(error=>logger.warn({error},'offline batch request failed'));},${OFFLINE_BATCH_IDLE_MS});};
    for(const tag of ['message','notification','receipt','call']) ws.on('CB:'+tag+',offline',()=>{if(offlinePending) scheduleOfflineBatch();});
    ws.on('close',()=>{offlinePending=false;clearTimeout(offlineIdle);});
    ws.on('CB:ib,,offline_preview', async (node) => {
        logger.info('offline preview received', JSON.stringify(node));
        offlinePending=true;
        await requestOfflineBatch();
        scheduleOfflineBatch();
    });`).replace(done,`    ws.on('CB:ib,,offline', (node) => {
        offlinePending=false;clearTimeout(offlineIdle);
        const child = getBinaryNodeChild(node, 'offline');`);
  // socket.js é ESM: valida a sintaxe sem executar o módulo.
  const check=require('node:child_process').spawnSync(process.execPath,['--input-type=module','--check'],{input:patched,encoding:'utf8'});
  if(check.status!==0) throw new Error('Patched Baileys socket failed the syntax check.');
  return patched;
}
const extension=createExtension();
module.exports={...extension,createExtension,patchBundle,patchBaileysSocket,isViewOnce};
if(require.main===module) {
  if(process.argv[2]!=='--patch') throw new Error('Use --patch during the image build.');
  const version=JSON.parse(fs.readFileSync('/evolution/package.json','utf8')).version;
  const path='/evolution/dist/main.js',original=fs.readFileSync(path,'utf8');
  const patched=patchBundle(original,version);fs.writeFileSync(path,patched);
  const baileysRoot='/evolution/node_modules/baileys',baileysVersion=JSON.parse(fs.readFileSync(baileysRoot+'/package.json','utf8')).version;
  const socketPath=baileysRoot+'/lib/Socket/socket.js';
  fs.writeFileSync(socketPath,patchBaileysSocket(fs.readFileSync(socketPath,'utf8'),baileysVersion));
  process.stdout.write('Verified Evolution 2.3.7 extension: authenticated timers, send inheritance, offline batch catch-up, archive sync and view-once media installed.\n');
}
