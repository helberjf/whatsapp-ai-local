(() => {
  'use strict';
  const $=id=>document.getElementById(id),token=document.querySelector('meta[name="whatsapp-session"]')?.content;
  // A página vem dos arquivos em disco: se a central em execução for anterior à atualização, avisa para reiniciá-la.
  async function checkCentralVersion() {
    try {
      const health=await fetch('/health',{cache:'no-store'}).then(response=>response.json());
      if(health?.service!=='whatsapp-local' || (health.build && !health.stale) || $('update-banner')) return;
      const banner=document.createElement('div');banner.id='update-banner';banner.className='update-banner';banner.setAttribute('role','alert');
      banner.textContent='A central aberta é de uma versão anterior à atualização baixada, por isso partes da tela podem falhar. Abra “Iniciar WhatsApp Local.cmd” para reiniciar com a versão nova.';
      document.body.prepend(banner);
    } catch {}
  }
  checkCentralVersion();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') checkCentralVersion();});
  let connection=null,chats=[],selected=null,templates=[],messages=[],page=1,pages=1,selection=0,syncing=false,sending=false,submitQueued=false,qrTimer=null,qrBusy=false,attachment=null,pendingSend=null,editRevision=0,detailsOpen=false,historyLoaded=false;
  const messageRows=new Map(),extras=()=>globalThis.WhatsAppExtras,VIRTUAL_AT=250;
  let virtualRows=null,rowHeight=0,chatsVersion=null;
  let chatLists=[],listContacts=[],listFilter='',listsPending=false,listsRefreshAt=0;
  const drafts=new Map(),readIds=new Set(),mediaUrls=new Map(),mediaRequests=new Map(),audioViews=new Map(),videoViews=new Map(),deletedMessages=new Set(),messageCopyViews=new Map(),forwardRequestIds=new Map(),hooks={sync:[],view:[],select:[],open:[]};
  const mediaControllers=new Map(),previewViews=new Map(),previewTargets=new WeakMap(),mediaLocks=new Set();
  const MEDIA_CACHE_ENTRIES=24,MEDIA_CACHE_BYTES=32*1024*1024;
  let mediaGeneration=0,previewActive=0,previewQueue=[],viewerMediaKey=null,focusedMediaKey=null;
  const previewObserver=globalThis.IntersectionObserver?new IntersectionObserver(entries=>{for(const entry of entries) {const view=previewTargets.get(entry.target);if(!view) continue;const entered=!view.visible;view.visible=entry.isIntersecting;if(entered && view.visible && !view.hasImage) queuePreview(view);}},{root:$('messages'),rootMargin:'160px'}):null;
  const runHooks=(name,...args)=>{for(const hook of hooks[name]) try {hook(...args);}catch {}};
  const transcriptionJobs=new Map(),transcriptionChoices=new Map(),transcriptionViews=new Map(),transcriptionErrors=new Map(),transcriptionRequests=new Set(),transcriptionLoads=new Set();
  let transcriptionSettings=null,transcriptionSettingsLoading=null;
  let historyQueue=Promise.resolve(),syncTask=Promise.resolve(),namesSyncing=false,forwardState=null,deleteState=null,attachmentKind=null,attachmentSelectionKind=null,activeMessageMenu=null;
  let transcriptRequest=null;
  const statuses={open:'Em aberto',pending:'Pendente',closed:'Concluído'};
  const time=value=>value?new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'';
  const dateTime=value=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
  const initials=name=>String(name || '?').split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase();
  const phoneLabel=value=>{const digits=String(value || '').replace(/\D/g,'');return /^55\d{10,11}$/.test(digits)?digits.replace(/^55(\d{2})(\d{4,5})(\d{4})$/,'+55 $1 $2-$3'):digits?'+'+digits:'Nenhuma conta conectada';};
  function el(tag,className,text) {const node=document.createElement(tag);if(className) node.className=className;if(text!==undefined) node.textContent=text;return node;}
  async function api(route,method='GET',input,timeout=30000,signal) {
    let response;
    try {response=await fetch('/api'+route,{method,headers:{'X-WhatsApp-Token':token,...globalThis.WhatsAppAccounts?.headers?.(),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:signal || AbortSignal.timeout(timeout)});}
    // Sem resposta nenhuma (central fechada ou reiniciando), o navegador só diz "Failed to fetch": explica o que fazer.
    catch(error) {if(error?.name==='TypeError') throw new Error('A central não está respondendo. Se ela foi fechada, abra "Iniciar WhatsApp Central" e recarregue a página.');throw error;}
    const result=await response.json();if(!response.ok) throw new Error(result.error || 'Não foi possível completar a operação.');return result;
  }
  function notice(message,success=false) {$('notice').textContent=message;$('notice').classList.toggle('success',success);$('notice').hidden=!message;}
  function showConnection(value) {
    connection=value;const online=value.state==='connected';
    $('panel-connection-state').textContent=online?'Conectado':value.state==='connecting'?'Aguardando leitura do QR Code':value.reachable?'Pronto para conectar':'Conector indisponível';
    $('panel-connection-phone').textContent=online?phoneLabel(value.phone):'Nenhuma conta conectada';
    $('sync-label').textContent=online?(value.events?.connected?'Tempo real · eventos do WhatsApp':'Atualização automática'):'Aguardando conexão';
    $('status-whatsapp').textContent=online?'Conectado':value.state==='connecting'?'Aguardando QR':'Desconectado';$('dot-whatsapp').classList.toggle('on',online);
    $('connection-badge').textContent=online?'Conectado':value.state==='connecting'?'Aguardando leitura':value.reachable?'Pronto para conectar':'Conector indisponível';
    $('connection-badge').classList.toggle('connected',online);
    $('connection-title').textContent=online?'Seu WhatsApp está conectado':value.reachable?'Conecte sua conta':'Inicie o conector local';
    $('connection-description').textContent=online?`Conta ${value.phone?'+'+value.phone:'conectada'} · sessão salva neste computador.`:value.reachable?'Abra o QR Code aqui e faça a leitura pelo celular.':'Abra Iniciar WhatsApp Local.cmd e aguarde o Docker ficar pronto.';
    $('connect').hidden=online;$('connect').disabled=!value.reachable || qrBusy;$('disconnect').hidden=!online;
    $('new-chat').disabled=!online;$('send').disabled=!online || sending;
    for(const id of ['sync-contact-names','panel-sync-contact-names']) $(id).disabled=!online || namesSyncing;
    if(online && $('qr-dialog').open) {$('qr-dialog').close();notice('WhatsApp conectado. Suas conversas aparecerão conforme forem sincronizadas.',true);}
  }
  function renderChats() {
    const search=$('search').value.trim().toLocaleLowerCase('pt-BR'),status=$('status-filter').value;
    const unreadChat=chat=>chat.unread>0 || chat.markedUnread===true;
    const matching=conversationsForFilter().filter(chat=>(!$('unread-only').checked || unreadChat(chat)) && (!status || chat.status===status) && (!search || `${chat.name} ${chat.phone || ''} ${chat.jid} ${chat.labels.join(' ')}`.toLocaleLowerCase('pt-BR').includes(search)));
    const filtered=extras()?.arrangeChats?.(matching) || matching;renderGroupsRow();
    const active=chats.filter(chat=>chat.archived!==true && !chat.isGroup),unreadCount=active.filter(unreadChat).length,pendingCount=active.filter(chat=>chat.status==='pending').length;
    $('metric-total').textContent=active.length;$('metric-unread').textContent=unreadCount;$('metric-pending').textContent=pendingCount;$('metric-closed').textContent=active.filter(chat=>chat.status==='closed').length;$('chat-count').textContent=filtered.length;
    $('filter-total-count').textContent=active.length;$('nav-chat-count').textContent=active.length;$('filter-unread-count').textContent=unreadCount;$('nav-pending-count').textContent=pendingCount;
    $('filter-all').classList.toggle('active',!listFilter && !status && !$('unread-only').checked);$('filter-pending').classList.toggle('active',status==='pending');
    $('filter-all').setAttribute('aria-pressed',String(!listFilter && !status && !$('unread-only').checked));$('filter-pending').setAttribute('aria-pressed',String(status==='pending'));
    // Listas grandes: só as linhas visíveis vão para a página (o restante vira espaço reservado).
    if(filtered.length>VIRTUAL_AT) {virtualRows=filtered;renderChatWindow();return;}
    virtualRows=null;
    const fragment=document.createDocumentFragment();
    for(const chat of filtered) fragment.append(chatButton(chat));
    if(!filtered.length) fragment.append(el('div','list-empty',connection?.state==='connected'?(chats.length?'Nenhuma conversa corresponde a estes filtros.':'Nenhuma conversa por aqui ainda. Use ＋ para abrir um atendimento.'):'Conecte seu WhatsApp para carregar as conversas.'));
    $('chat-list').replaceChildren(fragment);
  }
  function renderGroupsRow() {
    const groups=chats.filter(chat=>chat.isGroup),open=listFilter==='groups',unread=groups.filter(chat=>Number(chat.unread)>0).length;
    $('groups-row').hidden=!groups.length && !open;
    $('groups-row').setAttribute('aria-pressed',String(open));$('groups-row').classList.toggle('back',open);
    $('groups-row-label').textContent=open?'← Voltar às conversas':'Grupos';
    $('groups-row-count').textContent=open || !unread?'':String(unread);
    $('groups-row').title=`${groups.length} grupo${groups.length===1?'':'s'}${unread?` · ${unread} com mensagem não vista`:''}`;
    // Dentro dos grupos, a linha de arquivadas some para as duas visões não se misturarem.
    if(open) {$('archived-row').hidden=true;const title=$('inbox-title').firstChild;if(title) title.textContent='Grupos ';}
  }
  function conversationsForFilter() {
    // Grupos ficam à parte, como as arquivadas: aparecem pela linha "Grupos" ou numa busca.
    if(!listFilter) return $('search').value.trim()?chats:chats.filter(chat=>!chat.isGroup);
    if(listFilter==='groups') return chats.filter(chat=>chat.isGroup);
    const members=new Set(chatLists.find(list=>'list:'+list.id===listFilter)?.jids || []);
    const result=[];
    for(const chat of [...chats,...listContacts]) {
      const ids=[chat.jid,...(chat.aliasJids || [])];
      if(!ids.some(jid=>members.has(jid))) continue;
      result.push({status:'open',labels:[],...chat});
      ids.forEach(jid=>members.delete(jid));
    }
    for(const jid of members) {
      const isGroup=jid.endsWith('@g.us'),id=jid.split('@')[0];
      result.push({jid,isGroup,name:isGroup?'Grupo '+id:jid.endsWith('@lid')?'Contato '+id:phoneLabel(id),status:'open',labels:[]});
    }
    return result;
  }
  async function syncChatLists(force) {
    if(listsPending || (!force && Date.now()<listsRefreshAt)) return;
    listsPending=true;
    try {
      const result=await api('/chat-lists','GET',undefined,115000);
      chatLists=result.lists;listContacts=result.contacts || [];
      const filter=$('chat-list-filter'),options=[el('option','','Conversas individuais'),el('option','','Grupos')];
      options[0].value='';options[1].value='groups';
      for(const list of chatLists) {const option=el('option','',list.name);option.value='list:'+list.id;options.push(option);}
      if(!options.some(option=>option.value===listFilter)) listFilter='';
      filter.replaceChildren(...options);filter.value=listFilter;renderChats();
    } catch {}
    finally {listsPending=false;listsRefreshAt=Date.now()+60_000;}
  }
  function renderChatWindow() {
    const list=$('chat-list'),rows=virtualRows;if(!rows) return;
    const height=rowHeight || 76,top=list.scrollTop || 0,view=list.clientHeight || 900;
    const start=Math.max(0,Math.floor(top/height)-8),end=Math.min(rows.length,Math.ceil((top+view)/height)+8);
    const fragment=document.createDocumentFragment(),before=el('div','chat-spacer'),after=el('div','chat-spacer');
    before.style.height=start*height+'px';after.style.height=(rows.length-end)*height+'px';before.setAttribute('aria-hidden','true');after.setAttribute('aria-hidden','true');
    fragment.append(before);for(let index=start;index<end;index++) fragment.append(chatButton(rows[index]));fragment.append(after);
    list.replaceChildren(fragment);list.setAttribute('aria-rowcount',String(rows.length));
    // Mede a altura real de uma linha (com borda) na primeira vez e redesenha com a medida certa.
    if(!rowHeight) {const items=list.querySelectorAll?.('.chat-item');const measured=items?.length>1?items[1].offsetTop-items[0].offsetTop:items?.[0]?.offsetHeight;if(measured>20) {rowHeight=measured;renderChatWindow();}}
  }
  function chatButton(chat) {
      const button=el('button','chat-item'+(selected?.jid===chat.jid?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(selected?.jid===chat.jid));
      const avatar=el('span','avatar',initials(chat.name));globalThis.WhatsAppAvatars?.decorate?.(avatar,chat);button.append(avatar);
      const copy=el('span','chat-text'),title=el('span','chat-title');title.append(el('strong','',chat.name));
      if(chat.isGroup) title.append(el('span','chat-status','Grupo'));
      if(['pending','closed'].includes(chat.status)) title.append(el('span','chat-status '+chat.status,statuses[chat.status]));
      if(chat.aiMode==='draft' || chat.aiMode==='auto') title.append(el('span','chat-status ai',chat.aiDraft && chat.lastMessage && !chat.lastMessage.fromMe?'IA: rascunho pronto':chat.aiMode==='auto'?'IA automática':'IA rascunho'));
      title.append(el('time','',time(chat.lastMessage?.timestamp)));
      const preview=el('span','chat-preview');preview.append(el('p','',previewText(chat.lastMessage) || (chat.isGroup?'Sem mensagens sincronizadas':statuses[chat.status])));
      if(chat.unread) preview.append(el('span','unread-count',Math.min(chat.unread,999)));
      else if(chat.markedUnread) {const dot=el('span','unread-count marked','');dot.setAttribute('aria-label','Marcada como não lida');preview.append(dot);}
      copy.append(title,preview);button.append(copy);extras()?.decorateChat?.(button,chat,title);button.addEventListener('click',()=>extras()?.onChatClick?.(chat)?undefined:selectChat(chat));
      return button;
  }
  let virtualScroll=false;
  $('chat-list').addEventListener('scroll',()=>{if(!virtualRows || virtualScroll) return;virtualScroll=true;(globalThis.requestAnimationFrame || setTimeout)(()=>{virtualScroll=false;renderChatWindow();});});
  // Prévia da última mensagem na lista, como no WhatsApp: tipo do conteúdo e reações identificados.
  function previewText(message) {
    if(!message) return '';
    if(message.type==='reaction') return (message.fromMe?'Você reagiu ':'Reagiu ')+(message.reaction?.emoji || message.text || '');
    if(message.type==='location') return '📍 '+(message.text || 'Localização');
    if(message.type==='contact') return '👤 '+(message.text || 'Contato');
    if(message.type==='audio' && !message.text) return '🎤 '+(message.voice?'Mensagem de voz':'Áudio');
    if(message.type==='deleted') return '⊘ Mensagem apagada';
    return message.text || (message.type && message.type!=='text'?'Anexo recebido':'');
  }
  function mergeMessages(records) {const all=new Map(messages.map(item=>[item.id,item]));let changed=false;for(const message of records) {if(JSON.stringify(all.get(message.id))!==JSON.stringify(message)) changed=true;all.set(message.id,message);}messages=[...all.values()].sort((a,b)=>a.timestamp-b.timestamp);return changed;}
  const transcriptionKey=(jid,messageId)=>jid+'|'+messageId;
  const pendingTranscription=job=>job && ['queued','running'].includes(job.status);
  function latestTranscription(jid,messageId,provider) {
    return [...(transcriptionJobs.get(jid)?.values() || [])].filter(job=>job.messageId===messageId && job.provider===provider)
      .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  }
  const latestKnownTranscription=(jid,messageId)=>[...(transcriptionJobs.get(jid)?.values() || [])].find(job=>job.messageId===messageId);
  function rememberTranscriptions(jid,jobs) {
    if(!transcriptionJobs.has(jid)) transcriptionJobs.set(jid,new Map());
    const saved=transcriptionJobs.get(jid);
    for(const job of jobs) {
      if(job.jid!==jid || !job.id) continue;
      const previous=saved.get(job.id);
      if(!previous || String(job.updatedAt)>=String(previous.updatedAt)) saved.set(job.id,job);
    }
  }
  function updateTranscription(view) {
    // Sem escolha manual, o painel acompanha o transcritor que já tratou o áudio (por exemplo, a transcrição automática).
    if(!transcriptionChoices.has(transcriptionKey(view.jid,view.messageId))) {const existing=[...(transcriptionJobs.get(view.jid)?.values() || [])].filter(item=>item.messageId===view.messageId).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];if(existing && existing.provider!==view.provider.value) view.provider.value=existing.provider;}
    const provider=view.provider.value,key=transcriptionKey(view.jid,view.messageId),job=latestTranscription(view.jid,view.messageId,provider),error=transcriptionErrors.get(key+'|'+provider);
    const busy=transcriptionRequests.has(key+'|'+provider),pending=pendingTranscription(job),failed=job?.status==='failed' || Boolean(error);
    view.button.disabled=busy || pending;view.provider.disabled=busy;
    view.button.textContent=busy?'Solicitando…':pending?'Transcrevendo…':failed?'Tentar novamente':'Transcrever';
    view.disclosure.hidden=provider!=='ai';
    const source=(job?.auto?'Automática · ':'')+(provider==='ai'?'IA · OpenAI':'Whisper local');
    const status=busy?'Solicitando transcrição…':error?error:job?.status==='completed'?source+' · Transcrição concluída':job?.status==='failed'?(job.error || 'Não foi possível transcrever este áudio.'):job?.status==='running'?source+' · Transcrevendo…':job?.status==='queued'?source+' · Na fila…':'';
    if(view.status.textContent!==status) view.status.textContent=status;
    view.status.hidden=!status;view.status.classList.toggle('transcription-error',failed);
    const text=job?.status==='completed'?job.text || 'Nenhuma fala identificada.':'';
    if(view.text.textContent!==text) view.text.textContent=text;
    view.text.hidden=!text;view.copy.hidden=!job?.text || job.status!=='completed';
  }
  function updateTranscriptionViews(jid=selected?.jid) {
    if(selected?.jid!==jid) return;
    for(const view of transcriptionViews.values()) if(view.jid===jid) updateTranscription(view);
    for(const view of messageCopyViews.values()) if(view.jid===jid) view.button.disabled=!messageCopyText(view.message,jid);
  }
  function audioTranscription(message,jid) {
    const key=transcriptionKey(jid,message.id),panel=el('section','audio-transcription'),controls=el('div','transcription-controls'),provider=el('select','transcription-provider');
    panel.setAttribute('aria-label','Transcrição do áudio');provider.setAttribute('aria-label','Transcritor deste áudio');
    for(const [value,label] of [['whisper','Whisper local (padrão)'],['ai','IA (OpenAI)']]) {const option=el('option','',label);option.value=value;provider.append(option);}
    provider.value=transcriptionChoices.get(key) || 'whisper';
    const button=el('button','transcribe-button','Transcrever');button.type='button';controls.append(provider,button);
    const disclosure=el('p','transcription-disclosure','Este áudio será enviado à OpenAI para transcrição.'),status=el('p','transcription-status'),text=el('p','transcription-text'),copy=el('button','text-button transcription-copy','Copiar transcrição');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');copy.type='button';
    const view={jid,messageId:message.id,provider,button,disclosure,status,text,copy};transcriptionViews.set(key,view);
    provider.addEventListener('change',async()=>{
      transcriptionChoices.set(key,provider.value);updateTranscription(view);
      if(provider.value==='ai') {
        const version=selection;
        try {const settings=transcriptionSettings || await loadTranscriptionSettings();if(selected?.jid===jid && selection===version && !settings.aiConfigured) await openTranscriptionSettings('Adicione sua chave da OpenAI para usar a IA neste áudio.');}
        catch(error) {if(selected?.jid===jid && selection===version) {transcriptionErrors.set(key+'|ai',error.message);updateTranscription(view);}}
      }
    });
    button.addEventListener('click',()=>startTranscription(view));
    copy.addEventListener('click',async()=>{
      const job=latestTranscription(jid,message.id,provider.value);if(!job?.text) return;
      try {await navigator.clipboard.writeText(job.text);notice('Transcrição copiada.',true);}catch {notice('Não foi possível copiar. Selecione o texto da transcrição para copiar.');}
    });
    panel.append(controls,disclosure,status,text,copy);updateTranscription(view);return panel;
  }
  async function startTranscription(view) {
    const {jid,messageId}=view,version=selection,provider=view.provider.value,key=transcriptionKey(jid,messageId)+'|'+provider;
    const job=latestTranscription(jid,messageId,provider);
    if(selected?.jid!==jid || transcriptionRequests.has(key) || pendingTranscription(job)) return;
    if(provider==='ai') {
      try {const settings=transcriptionSettings || await loadTranscriptionSettings();if(selected?.jid!==jid || selection!==version) return;if(!settings.aiConfigured) {await openTranscriptionSettings('Adicione sua chave da OpenAI para usar a IA neste áudio.');return;}}
      catch(error) {transcriptionErrors.set(key,error.message);updateTranscriptionViews(jid);return;}
    }
    const retry=job?.status==='failed' || transcriptionErrors.has(key);transcriptionRequests.add(key);transcriptionErrors.delete(key);updateTranscriptionViews(jid);
    try {
      const result=await api('/transcriptions','POST',{jid,messageId,provider,...(retry?{retry:true}:{})});rememberTranscriptions(jid,[result]);
    } catch(error) {transcriptionErrors.set(key,error.message);}
    finally {transcriptionRequests.delete(key);if(selected?.jid===jid && selection===version) updateTranscriptionViews(jid);}
  }
  async function loadTranscriptions(jid=selected?.jid,version=selection) {
    if(!jid) return;
    const key=jid+'|'+version;if(transcriptionLoads.has(key)) return;transcriptionLoads.add(key);
    try {
      const jobs=await api('/transcriptions?jid='+encodeURIComponent(jid));rememberTranscriptions(jid,jobs);
      if(selected?.jid===jid && selection===version) updateTranscriptionViews(jid);
    } finally {transcriptionLoads.delete(key);}
  }
  async function pollTranscriptions() {
    const jid=selected?.jid,version=selection;
    if(!jid || document.visibilityState==='hidden' || !messages.some(message=>message.type==='audio' && !message.deleted)) return;
    try {await loadTranscriptions(jid,version);}catch(error) {if(selected?.jid===jid && selection===version) notice('Não foi possível atualizar as transcrições: '+error.message);}
  }
  const audioTime=value=>Number.isFinite(value) && value>=0?Math.floor(value/60)+':'+String(Math.floor(value%60)).padStart(2,'0'):'--:--';
  // Áudios pequenos carregam sozinhos quando aparecem na tela (dois por vez); os grandes esperam o clique.
  const AUDIO_AUTO_BYTES=3*1024*1024,AUDIO_AUTO_SECONDS=600,audioQueue=[];let audioActive=0;
  const audioSize=bytes=>bytes>=1048576?(bytes/1048576).toFixed(1).replace('.',',')+' MB':Math.max(1,Math.round(bytes/1024))+' KB';
  const audioAuto=message=>!(message.bytes>AUDIO_AUTO_BYTES) && !(message.durationSeconds>AUDIO_AUTO_SECONDS);
  function pumpAudio() {
    while(audioActive<2 && audioQueue.length) {
      const view=audioQueue.shift();if(!view.card.isConnected || view.player.src || view.loading) continue;
      audioActive++;view.loadAudio(false).finally(()=>{audioActive--;pumpAudio();});
    }
  }
  const audioObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    for(const entry of entries) if(entry.isIntersecting) {audioObserver.unobserve(entry.target);const view=entry.target.audioView;if(view) {audioQueue.push(view);pumpAudio();}}
  },{rootMargin:'300px 0px'}):null;
  function audioCard(message,jid) {
    const key=jid+'|'+message.id;if(audioViews.has(key)) return audioViews.get(key).card;
    const card=el('section','audio-card'),main=el('div','audio-main'),play=el('button','audio-play','▶'),track=el('div','audio-track'),wave=el('div','audio-wave'),row=el('div','audio-row');
    const clock=el('span','audio-time'),speed=el('div','audio-speed'),note=el('small','audio-note'),player=el('audio','audio-player'),status=el('p','audio-status');
    card.setAttribute('aria-label','Mensagem de voz');play.type='button';play.setAttribute('aria-label','Reproduzir áudio');
    player.preload='none';player.hidden=true;status.setAttribute('role','status');status.hidden=true;note.hidden=true;
    const known=Number.isFinite(message.durationSeconds)?message.durationSeconds:NaN;
    const updateTime=()=>{const total=Number.isFinite(player.duration)?player.duration:known;clock.textContent=(player.src?audioTime(player.currentTime || 0)+' / ':'')+audioTime(total);};
    // Onda fixa por mensagem: as alturas vêm do id, então não mudam a cada atualização da tela.
    let seed=0;for(const char of String(message.id)) seed=(seed*31+char.charCodeAt(0))>>>0;
    const bars=[];for(let index=0;index<36;index++) {seed=(seed*1103515245+12345)>>>0;const bar=el('i');bar.setAttribute('style','height:'+(5+seed%19)+'px');bars.push(bar);wave.append(bar);}
    wave.setAttribute('role','slider');wave.setAttribute('aria-label','Posição do áudio');wave.tabIndex=0;
    const paint=()=>{const total=player.duration,ratio=Number.isFinite(total) && total>0?player.currentTime/total:0,played=Math.round(ratio*bars.length);bars.forEach((bar,index)=>bar.classList.toggle('played',index<played));wave.setAttribute('aria-valuenow',String(Math.round(ratio*100)));};
    let rate=1;const rates=[];
    for(const [value,label] of [[1,'1×'],[1.5,'1,5×'],[2,'2×']]) {
      const button=el('button','audio-rate',label);button.type='button';button.dataset.rate=String(value);button.setAttribute('aria-pressed',String(value===rate));
      button.addEventListener('click',()=>{rate=value;player.defaultPlaybackRate=value;player.playbackRate=value;for(const item of rates) item.setAttribute('aria-pressed',String(item===button));});
      rates.push(button);speed.append(button);
    }
    speed.setAttribute('role','group');speed.setAttribute('aria-label','Velocidade de reprodução');
    const view={card,load:play,clock,player,speed,status,loading:false};audioViews.set(key,view);card.audioView=view;
    const icon=()=>{const playing=Boolean(player.src) && !player.paused;play.textContent=playing?'❚❚':'▶';play.setAttribute('aria-label',playing?'Pausar áudio':'Reproduzir áudio');card.classList.toggle('playing',playing);};
    view.loadAudio=async(start)=>{
      if(view.loading) return;if(player.src) {if(start) await Promise.resolve(player.play?.()).catch(()=>{});return;}
      view.loading=true;card.classList.add('loading');play.disabled=true;status.hidden=true;
      try {
        const media=await fetchMedia(message,jid);if(audioViews.get(key)!==view) return;
        player.src=media.url;player.defaultPlaybackRate=rate;player.playbackRate=rate;note.hidden=true;card.classList.add('ready');updateTime();
        if(start) await Promise.resolve(player.play?.()).catch(()=>{});
      } catch(error) {status.textContent=error.message+' Toque em ▶ para tentar de novo.';status.hidden=false;}
      finally {view.loading=false;card.classList.remove('loading');play.disabled=false;icon();trimMediaCache();}
    };
    // Ao liberar memória, o cartão volta a esperar: o próximo ▶ baixa o áudio de novo.
    view.reset=()=>{card.classList.remove('ready','playing');bars.forEach(bar=>bar.classList.remove('played'));icon();updateTime();};
    play.addEventListener('click',()=>{focusedMediaKey=key;if(!player.src) return view.loadAudio(true);if(player.paused) Promise.resolve(player.play?.()).catch(()=>{});else player.pause?.();});
    const seek=ratio=>{if(player.src && Number.isFinite(player.duration)) {player.currentTime=Math.max(0,Math.min(1,ratio))*player.duration;paint();}};
    wave.addEventListener('click',event=>{const box=wave.getBoundingClientRect();seek((event.clientX-box.left)/box.width);});
    wave.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key) || !Number.isFinite(player.duration)) return;event.preventDefault();seek((player.currentTime+(event.key==='ArrowRight'?5:-5))/player.duration);});
    for(const event of ['loadedmetadata','durationchange','timeupdate']) player.addEventListener(event,()=>{updateTime();paint();});
    for(const event of ['play','pause','ended']) player.addEventListener(event,icon);
    player.addEventListener('ended',()=>{player.currentTime=0;paint();updateTime();});
    player.addEventListener('error',()=>{if(!player.getAttribute('src')) return;status.textContent='Não foi possível reproduzir este formato de áudio. Toque em ▶ para tentar de novo.';status.hidden=false;player.removeAttribute('src');view.reset();});
    if(audioAuto(message)) audioObserver?.observe(card);
    else {note.textContent='Áudio grande'+(message.bytes?' ('+audioSize(message.bytes)+')':'')+': toque em ▶ para carregar.';note.hidden=false;}
    updateTime();
    track.append(wave,row);row.append(clock,speed);main.append(play,track);card.append(main,note,player,status);return card;
  }
  function videoCard(message,jid) {
    const key=jid+'|'+message.id;if(videoViews.has(key)) return videoViews.get(key).card;
    const card=el('section','video-card'),label=el('div','media-card-label','Vídeo'),load=el('button','video-load','▶ Reproduzir vídeo'),player=el('video','video-player'),status=el('p','media-status');
    card.setAttribute('aria-label','Mensagem de vídeo');load.type='button';load.setAttribute('aria-label','Reproduzir vídeo');player.controls=true;player.preload='none';player.playsInline=true;player.hidden=false;player.setAttribute('aria-label','Player de vídeo');status.hidden=true;status.setAttribute('role','status');
    const thumbnail=thumbnailUrl(message);if(thumbnail) player.poster=thumbnail;
    const metadata=el('p','video-metadata',[message.fileName,Number.isFinite(message.durationSeconds)?audioTime(message.durationSeconds):null].filter(Boolean).join(' · ') || 'Carregue o vídeo para reproduzir');
    const view={card,player,load,status,loading:false};videoViews.set(key,view);
    load.addEventListener('click',async()=>{if(view.loading) return;focusedMediaKey=key;const version=selection;view.loading=true;load.disabled=true;load.textContent='Carregando vídeo…';status.hidden=true;
      try {const media=await fetchMedia(message,jid);player.preload='metadata';player.src=media.url;player.hidden=false;load.hidden=true;player.load?.();
        if(selected?.jid===jid && selection===version) {for(const other of document.querySelectorAll('audio,video')) if(other!==player && !other.paused) other.pause?.();
          try {await player.play?.();}catch(error) {status.textContent=error.name==='NotAllowedError'?'Vídeo carregado. Toque no ▶ do player para iniciar.':'Toque no ▶ do player para reproduzir. Se o formato não abrir, use Baixar vídeo.';status.hidden=false;}
        }
      }
      catch(error) {status.textContent=error.message;status.hidden=false;load.hidden=false;load.textContent='↻ Tentar carregar vídeo';}
      finally {view.loading=false;load.disabled=false;trimMediaCache();}
    });
    player.addEventListener('error',()=>{status.textContent='Este formato não pode ser reproduzido no navegador. Baixe o arquivo para abrir no seu computador.';status.hidden=false;load.hidden=false;load.textContent='↻ Carregar novamente';});
    const download=el('button','text-button media-download','↓ Baixar vídeo');download.type='button';download.addEventListener('click',()=>downloadMedia(message,jid,download));
    card.append(label,player,metadata,load,download,status);return card;
  }
  function linkedText(text) {
    const paragraph=el('p','message-text'),pattern=/(?:https?:\/\/|www\.)[^\s<>"']+/gi;let position=0;
    for(const match of text.matchAll(pattern)) {
      const raw=match[0].replace(/[.,;!?)\]}]+$/,'');if(!raw) continue;
      if(match.index>position) paragraph.append(el('span','',text.slice(position,match.index)));
      try {const url=new URL(raw.startsWith('www.')?'https://'+raw:raw);if(!['https:','http:'].includes(url.protocol) || url.username || url.password) throw Error();
        const link=el('a','message-link',raw);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';paragraph.append(link);
      } catch {paragraph.append(el('span','',raw));}
      position=match.index+raw.length;
    }
    if(position<text.length) paragraph.append(el('span','',text.slice(position)));return paragraph;
  }
  function messageCopyText(message,jid) {
    if(message.viewOnce) return '';
    if(message.text || message.caption) return message.text || message.caption;
    if(message.type!=='audio') return '';
    const provider=transcriptionChoices.get(transcriptionKey(jid,message.id)) || 'whisper';
    const preferred=latestTranscription(jid,message.id,provider);
    if(preferred?.status==='completed' && preferred.text) return preferred.text;
    return [...(transcriptionJobs.get(jid)?.values() || [])].filter(job=>job.messageId===message.id && job.status==='completed' && job.text).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.text || '';
  }
  function messageActions(message,jid) {
    const menu=el('details','message-actions'),toggle=el('summary','message-menu-toggle','⌄'),options=el('div','message-menu'),forward=el('button','message-forward','Encaminhar'),copy=el('button','message-copy','Copiar texto');
    toggle.setAttribute('aria-label','Opções da mensagem');options.setAttribute('popover','manual');forward.type='button';forward.disabled=message.canForward===false;if(forward.disabled) forward.title='Este tipo de mensagem não pode ser encaminhado.';copy.type='button';copy.disabled=!messageCopyText(message,jid);
    menu.addEventListener('toggle',()=>{
      if(!menu.open) {if(activeMessageMenu?.menu===menu) closeMessageMenu();return;}
      if(activeMessageMenu?.menu!==menu) closeMessageMenu();activeMessageMenu={menu,options};
      try {options.showPopover?.();}catch {}
      if(!toggle.getBoundingClientRect) return;
      const anchor=toggle.getBoundingClientRect(),box=options.getBoundingClientRect(),region=$('messages').getBoundingClientRect(),width=globalThis.innerWidth,height=globalThis.innerHeight;
      const left=Math.max(8,region.left+4),right=Math.min(width-8,region.right-4),top=Math.max(8,region.top+4),bottom=Math.min(height-8,region.bottom-4);
      const x=Math.max(left,Math.min(message.fromMe?anchor.right-box.width:anchor.left,right-box.width));
      const y=Math.max(top,Math.min(anchor.bottom+6+box.height>bottom?anchor.top-box.height-6:anchor.bottom+6,bottom-box.height));
      options.style.left=x+'px';options.style.top=y+'px';
    });
    messageCopyViews.set(jid+'|'+message.id,{jid,message,button:copy});
    forward.addEventListener('click',()=>{if(message.canForward===false) return;menu.open=false;openForward(message,jid);});
    copy.addEventListener('click',async()=>{const text=messageCopyText(message,jid);if(!text) return;menu.open=false;try {await navigator.clipboard.writeText(text);notice('Texto copiado.',true);}catch {notice('Não foi possível copiar. Selecione o texto da mensagem para copiar.');}});
    options.append(forward,copy);
    if(message.type==='audio' && !message.deleted && !message.viewOnce && !jid.endsWith('@g.us')) {
      const priority=el('button','message-prioritize-transcription','Priorizar transcrição');priority.type='button';
      priority.addEventListener('click',async()=>{
        if(priority.disabled) return;priority.disabled=true;menu.open=false;
        try {
          const loaded=await api('/transcriptions?jid='+encodeURIComponent(jid));
          rememberTranscriptions(jid,loaded);
          const jobs=loaded.filter(job=>job.messageId===message.id);
          const pending=jobs.find(pendingTranscription),completed=jobs.find(job=>job.status==='completed');
          if(!pending && completed) {notice('Este áudio já foi transcrito.',true);return;}
          const result=await api('/transcriptions','POST',{jid,messageId:message.id,provider:pending?.provider || 'whisper',priority:true,retry:true});
          rememberTranscriptions(jid,[result]);updateTranscriptionViews(jid);
          notice(result.status==='running'?'Este áudio já está sendo transcrito.':result.status==='completed'?'Este áudio já foi transcrito.':'Áudio colocado no início da fila de transcrição.',true);
        } catch(error) {notice(error.message);}finally {priority.disabled=false;}
      });options.append(priority);
    }
    try {extras()?.extendActions?.({options,message,jid,close:()=>{menu.open=false;}});}catch {}
    if(message.fromMe && !message.deleted && !deletedMessages.has(jid+'|'+message.id)) {
      const remove=el('button','message-delete','Apagar para todos');remove.type='button';remove.addEventListener('click',()=>{menu.open=false;deleteState={jid,messageId:message.id,requestId:crypto.randomUUID(),busy:false};$('delete-preview').textContent=message.text || 'Mensagem de '+message.type;$('delete-error').textContent='';$('delete-confirm').disabled=false;$('delete-dialog').showModal();});options.append(remove);
    }
    menu.append(toggle,options);return menu;
  }
  function closeMessageMenu() {const active=activeMessageMenu;activeMessageMenu=null;if(active){active.menu.open=false;try{active.options.hidePopover?.();}catch{}}}
  document.addEventListener('pointerdown',event=>{if(activeMessageMenu && !activeMessageMenu.menu.contains(event.target)) closeMessageMenu();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape') closeMessageMenu();});
  $('messages').addEventListener('scroll',closeMessageMenu);globalThis.addEventListener?.('resize',closeMessageMenu);
  $('delete-confirm').addEventListener('click',async()=>{
    const state=deleteState;if(!state || state.busy || !$('delete-dialog').open) return;state.busy=true;$('delete-confirm').disabled=true;$('delete-error').textContent='';
    try {await api('/messages/delete','POST',{jid:state.jid,messageId:state.messageId,requestId:state.requestId});deletedMessages.add(state.jid+'|'+state.messageId);if(selected?.jid===state.jid) renderMessages(true);if(deleteState===state) {$('delete-dialog').close();deleteState=null;}notice('Mensagem apagada para todos.',true);}
    catch(error) {if(deleteState===state) $('delete-error').textContent=error.message+' Confira no WhatsApp antes de tentar novamente.';}
    finally {state.busy=false;if(deleteState===state) $('delete-confirm').disabled=false;}
  });
  let infoVersion=0,temporaryTarget=null,temporaryVersion=0;
  $('contact-info-open').addEventListener('click',async()=>{
    if(!selected) return;const jid=selected.jid,version=++infoVersion;$('contact-info-dialog').showModal();$('contact-info-data').replaceChildren();$('contact-info-status').textContent='Carregando dados do WhatsApp…';
    try {const info=await api('/contact/details?jid='+encodeURIComponent(jid));if(version!==infoVersion || !$('contact-info-dialog').open) return;
      const add=(label,value)=>{if(value) $('contact-info-data').append(el('dt','',label),el('dd','',String(value)));};
      add('Nome',info.name);add('Telefone',info.phone?phoneLabel(info.phone):'Não disponibilizado pelo WhatsApp');add('Recado',info.about || 'Não disponível');add('Empresa',info.business?.description);add('Endereço',info.business?.address);add('E-mail',info.business?.email);add('Sites',info.business?.websites?.join('\n'));add('Identificador da conversa',jid);
      $('contact-info-status').textContent='Alguns dados dependem da privacidade definida pelo contato.';
    } catch(error) {if(version===infoVersion) $('contact-info-status').textContent=error.message;}
  });
  $('disappearing-open').addEventListener('click',async()=>{
    if(!selected) return;temporaryTarget=selected.jid;const version=++temporaryVersion;$('disappearing-dialog').showModal();$('disappearing-status').textContent='Verificando o conector…';$('disappearing-save').disabled=true;
    try {const info=await api('/contact/details?jid='+encodeURIComponent(temporaryTarget));if(version!==temporaryVersion || !$('disappearing-dialog').open || temporaryTarget!==info.jid) return;
      $('disappearing-save').disabled=!info.capabilities?.disappearingMessages;$('disappearing-status').textContent=info.capabilities?.disappearingMessages?'A alteração valerá para novas mensagens.':'O conector precisa da extensão local de mensagens temporárias. Reabra pelo iniciador para atualizar.';
      if([0,86400,604800,7776000].includes(info.disappearingMessages?.expiration)) $('disappearing-expiration').value=String(info.disappearingMessages.expiration);
    } catch(error) {if(version===temporaryVersion) $('disappearing-status').textContent=error.message;}
  });
  $('disappearing-dialog').addEventListener('close',()=>{temporaryVersion++;temporaryTarget=null;});
  $('disappearing-save').addEventListener('click',async()=>{
    const jid=temporaryTarget,version=temporaryVersion;if(!jid || $('disappearing-save').disabled) return;$('disappearing-save').disabled=true;
    try {await api('/messages/disappearing','POST',{jid,expiration:Number($('disappearing-expiration').value)});if(version===temporaryVersion) $('disappearing-dialog').close();notice('Prazo de mensagens atualizado no WhatsApp.',true);}
    catch(error) {if(version===temporaryVersion) $('disappearing-status').textContent=error.message;}
    finally {if(version===temporaryVersion) $('disappearing-save').disabled=false;}
  });
  function renderForwardDestinations() {
    if(!forwardState) return;
    const query=$('forward-search').value.trim().toLocaleLowerCase('pt-BR'),fragment=document.createDocumentFragment();
    for(const chat of chats.filter(chat=>/@(?:s\.whatsapp\.net|lid)$/.test(chat.jid) && (!query || `${chat.name} ${chat.phone || ''} ${chat.jid}`.toLocaleLowerCase('pt-BR').includes(query)))) {
      const button=el('button','forward-destination'+(forwardState.targetJid===chat.jid?' selected':''));button.type='button';button.disabled=forwardState.busy;button.setAttribute('aria-pressed',String(forwardState.targetJid===chat.jid));
      button.append(el('strong','',chat.name),el('small','',contactPhone(chat)));
      button.addEventListener('click',()=>{if(!forwardState || forwardState.busy) return;if(forwardState.targetJid!==chat.jid) {forwardState.targetJid=chat.jid;forwardState.requestId=null;}$('forward-error').textContent='';$('forward-recipient').textContent='Destinatário: '+chat.name;$('forward-confirm').disabled=false;renderForwardDestinations();});fragment.append(button);
    }
    if(!fragment.children.length) fragment.append(el('p','muted','Nenhum contato encontrado. Busque por nome ou telefone.'));
    $('forward-destinations').replaceChildren(fragment);
  }
  function openForward(message,sourceJid) {
    if(forwardState?.busy) return;
    forwardState={sourceJid,messageId:message.id,targetJid:null,requestId:null,busy:false};
    $('forward-preview').textContent=message.text || message.caption || ({audio:'Mensagem de áudio',image:'Imagem',video:'Vídeo',sticker:'Figurinha',document:message.fileName || 'Documento'}[message.type] || 'Anexo');
    $('forward-search').value='';$('forward-error').textContent='';$('forward-recipient').textContent='Selecione um contato para encaminhar.';$('forward-confirm').disabled=true;$('forward-confirm').textContent='Encaminhar';renderForwardDestinations();$('forward-dialog').showModal();
  }
  $('forward-search').addEventListener('input',renderForwardDestinations);
  $('forward-dialog').addEventListener('cancel',event=>{if(forwardState?.busy) event.preventDefault();});
  $('forward-close').addEventListener('click',()=>{if(!forwardState?.busy) $('forward-dialog').close();});
  $('forward-confirm').addEventListener('click',async()=>{
    const state=forwardState;if(!$('forward-dialog').open || !state?.targetJid || state.busy) return;
    const key=[state.sourceJid,state.messageId,state.targetJid].join('|');
    state.requestId=state.requestId || forwardRequestIds.get(key) || crypto.randomUUID();forwardRequestIds.set(key,state.requestId);state.busy=true;
    $('forward-confirm').disabled=true;$('forward-confirm').textContent='Encaminhando…';$('forward-close').disabled=true;$('forward-search').disabled=true;$('forward-error').textContent='';renderForwardDestinations();
    try {
      const result=await api('/forward','POST',{sourceJid:state.sourceJid,messageId:state.messageId,targetJid:state.targetJid,requestId:state.requestId});forwardRequestIds.delete(key);
      if(selected?.jid===state.targetJid && result?.id) {mergeMessages([result]);renderMessages();}
      $('forward-dialog').close();notice('Mensagem encaminhada para '+(chats.find(chat=>chat.jid===state.targetJid)?.name || 'o contato selecionado')+'.',true);
    } catch(error) {$('forward-error').textContent=error.message+' Confira a conversa de destino antes de tentar novamente.';}
    finally {state.busy=false;$('forward-confirm').disabled=!state.targetJid;$('forward-confirm').textContent='Encaminhar';$('forward-close').disabled=false;$('forward-search').disabled=false;renderForwardDestinations();}
  });
  function renderMessages(keepScroll=false,forceBottom=false) {
    const container=$('messages'),nearBottom=container.scrollHeight-container.scrollTop-container.clientHeight<90,oldHeight=container.scrollHeight,oldTop=container.scrollTop;
    const fragment=document.createDocumentFragment();transcriptionViews.clear();messageCopyViews.clear();messageRows.clear();previewObserver?.disconnect();previewViews.clear();previewQueue=[];
    const reactions=reactionsByMessage(selected.jid);
    for(const message of messages) {
      if(message.type==='reaction') continue;
      const row=el('article','message'+(message.fromMe?' mine':''));row.dataset.id=message.id;messageRows.set(message.id,row);
      const removed=message.deleted || deletedMessages.has(selected.jid+'|'+message.id);
      if(selected.isGroup && !message.fromMe && message.senderName) row.append(el('strong','green-ink',message.senderName));
      if(message.type==='sticker' && !removed) row.classList.add('sticker-message');
      if(message.quoted && !removed) row.append(quoteBlock(message.quoted));
      if(removed) {row.className+=' message-deleted';row.append(el('p','','⊘ Mensagem apagada'));}
      else if(message.viewOnce) {
        const label=el('p'),badge=el('span','view-once-badge','1');
        badge.setAttribute('aria-hidden','true');label.append(badge,message.text);row.append(label);
        if(!message.fromMe) row.append(el('small','muted','Abra no WhatsApp para acessar a mídia.'));
      }
      else if(message.type==='audio') row.append(audioCard(message,selected.jid));
      else if(message.type==='video') row.append(videoCard(message,selected.jid));
      else if(message.type==='poll') {const poll=el('section','poll-card');poll.append(el('strong','',message.poll?.name || message.text || 'Enquete'));for(const choice of message.poll?.options || []) poll.append(el('div','poll-option','◯ '+choice));poll.append(el('small','muted','Para votar, abra esta conversa no WhatsApp.'));row.append(poll);}
      else if(['image','sticker'].includes(message.type) || (message.type==='document' && (message.mimeType==='application/pdf' || /\.pdf$/i.test(message.fileName || '')))) row.append(previewCard(message,selected.jid));
      else if(message.type==='location') row.append(locationCard(message));
      else if(message.type==='contact') row.append(contactCard(message));
      else if(message.type!=='text') {
        const cached=mediaUrls.get(selected.jid+'|'+message.id);
        if(cached && ['image','sticker','audio','video'].includes(message.type)) {
          const media=el(message.type==='audio'?'audio':message.type==='video'?'video':'img');media.src=cached.url;
          if(media.tagName==='IMG') media.alt=message.text || 'Imagem da conversa';else {media.controls=true;media.preload='none';}row.append(media);
        } else {
          const button=el('button','text-button',message.type==='document'?'↓ Baixar '+(message.fileName || 'documento'):'↗ Abrir '+({image:'imagem',audio:'áudio',video:'vídeo',sticker:'figurinha'}[message.type] || 'anexo'));button.type='button';
          const messageJid=selected.jid;button.addEventListener('click',()=>loadMedia(message,messageJid,button));row.append(button);
        }
      }
      if(message.text && !removed && !message.viewOnce && !['poll','location','contact','sticker'].includes(message.type)) row.append(linkedText(message.text));
      if(message.type==='audio' && !removed && !selected.isGroup) row.append(audioTranscription(message,selected.jid));
      const chips=removed?[]:[...(reactions.get(message.id)?.values() || [])].filter(item=>item.emoji);
      if(chips.length) {const box=el('div','message-reactions');box.setAttribute('aria-label','Reações');for(const item of chips) {const chip=el('span','reaction-chip'+(item.fromMe?' mine':''),item.emoji);chip.title=item.fromMe?'Sua reação':'Reação do contato';box.append(chip);}row.append(box);}
      const star=!removed && extras()?.isStarred?.(selected.jid,message.id)?'★ ':'',edited=message.edited && !removed?' · Editada':'';
      if(!removed && !selected.isGroup) row.append(messageActions(message,selected.jid));
      const meta=el('span','message-meta'),clock=el('time','',star+time(message.timestamp)+edited);
      if(message.timestamp) clock.title=dateTime(message.timestamp);
      meta.append(clock);
      if(message.fromMe && !removed) meta.append(messageReceipt(message.deliveryStatus));
      row.append(meta);fragment.append(row);
    }
    if(!messages.length) fragment.append(el('p','muted','Ainda não há mensagens sincronizadas nesta conversa.'));
    closeMessageMenu();container.replaceChildren(fragment);$('older').hidden=page>=pages;$('history-info').textContent=messages.length?`${messages.length} mensagens carregadas`:'';
    if(keepScroll) container.scrollTop=oldTop+container.scrollHeight-oldHeight;
    else if(nearBottom || forceBottom) container.scrollTop=container.scrollHeight;
  }
  function messageReceipt(status) {
    const labels={pending:'Aguardando confirmação de envio',failed:'Falha no envio',sent:'Enviada',delivered:'Entregue',read:'Visualizada',played:'Reproduzida',unknown:'Status indisponível'};
    const label=labels[status] || labels.unknown,state=status==='played'?'read':status;
    const badge=el('span','message-receipt receipt-'+(state || 'unknown'));
    badge.setAttribute('role','img');badge.setAttribute('aria-label',label);badge.title=label;
    const ns='http://www.w3.org/2000/svg',icon=document.createElementNS(ns,'svg');
    icon.setAttribute('viewBox','0 0 18 12');icon.setAttribute('aria-hidden','true');
    const paths={
      sent:['M2 6l3 3 7-7'],delivered:['M1 6l3 3 7-7','M8 8l1 1 7-7'],
      pending:['M9 1.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z','M9 3.5v3l2 1'],
      failed:['M9 2v5m0 2.5v.5'],unknown:['M7 4a2 2 0 1 1 3 2c-1 .5-1 1-1 1.5m0 2v.5']
    };
    for(const line of paths[state==='read'?'delivered':state] || paths.unknown) {
      const path=document.createElementNS(ns,'path');path.setAttribute('d',line);icon.append(path);
    }
    badge.append(icon);return badge;
  }
  // Reações: vale a mais recente de cada lado (você e o contato); reação vazia remove a anterior.
  function reactionsByMessage(jid) {
    const result=new Map();
    for(const message of messages) {
      if(message.type!=='reaction' || !message.reaction?.targetId) continue;
      const list=result.get(message.reaction.targetId) || new Map(),who=message.fromMe?'me':'them',previous=list.get(who);
      if(!previous || Number(message.timestamp || 0)>=Number(previous.timestamp || 0)) list.set(who,{emoji:message.reaction.emoji,timestamp:message.timestamp,fromMe:message.fromMe});
      result.set(message.reaction.targetId,list);
    }
    for(const local of extras()?.pendingReactions?.(jid) || []) {
      const list=result.get(local.targetId) || new Map(),previous=list.get('me');
      if(!previous || Number(local.timestamp || 0)>Number(previous.timestamp || 0)) list.set('me',{emoji:local.emoji,timestamp:local.timestamp,fromMe:true});
      result.set(local.targetId,list);
    }
    return result;
  }
  function quoteBlock(quoted) {
    const original=messages.find(item=>item.id===quoted.id),fromMe=original?original.fromMe:quoted.fromMe,block=el('button','message-quote');block.type='button';
    block.append(el('strong','',fromMe===true?'Você':fromMe===false?(selected?.name || 'Contato'):'Mensagem citada'),el('span','',(original && !original.deleted?previewText(original):'') || quoted.text || 'Mensagem'));
    block.setAttribute('aria-label','Ir para a mensagem citada');
    block.addEventListener('click',()=>{const target=messageRows.get(quoted.id);if(target) {target.scrollIntoView?.({block:'center',behavior:'smooth'});target.classList.toggle('message-highlight',true);setTimeout(()=>target.classList.toggle('message-highlight',false),1600);}else notice('A mensagem citada não está carregada. Use "Carregar mensagens anteriores".');});
    return block;
  }
  function locationCard(message) {
    const card=el('section','location-card'),place=message.location || {};card.setAttribute('aria-label','Localização compartilhada');
    card.append(el('div','media-card-label',place.live?'📍 Localização em tempo real':'📍 Localização'));
    if(place.name) card.append(el('strong','',place.name));if(place.address) card.append(el('small','',place.address));
    if(Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
      const coords=place.latitude.toFixed(6)+','+place.longitude.toFixed(6),link=el('a','message-link location-link','Abrir no mapa ↗');
      link.href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(coords);link.target='_blank';link.rel='noopener noreferrer';card.append(el('small','muted',coords.replace(',',', ')),link);
    }
    return card;
  }
  function contactCard(message) {
    const card=el('section','contact-card');card.setAttribute('aria-label','Contato compartilhado');card.append(el('div','media-card-label','👤 Contato compartilhado'));
    for(const contact of message.contacts || []) {
      const item=el('div','contact-card-item');item.append(el('strong','',contact.name));
      for(const phone of contact.phones || []) {
        const line=el('div','contact-card-phone'),open=el('button','text-button','Conversar');open.type='button';line.append(el('span','',phoneLabel(phone)),open);
        open.addEventListener('click',async()=>{open.disabled=true;try {const found=await api('/resolve-phone','POST',{phone:'+'+phone});await selectChat(chats.find(chat=>chat.jid===found.jid) || {...found,status:'open',labels:[],unread:0});}catch(error) {notice(error.message);}finally {open.disabled=false;}});
        item.append(line);
      }
      if(!contact.phones?.length) item.append(el('small','muted','Sem número disponível no cartão.'));
      card.append(item);
    }
    return card;
  }
  function cachedMedia(key) {const media=mediaUrls.get(key);if(media) {mediaUrls.delete(key);mediaUrls.set(key,media);}return media;}
  function releasePlayer(view,video=false) {
    view.player.pause?.();view.player.removeAttribute('src');view.player.load?.();view.player.hidden=!video;view.load.hidden=false;view.load.disabled=false;
    if(view.speed) view.speed.disabled=true;
    view.reset?.();
  }
  function protectedMedia(key) {return key===viewerMediaKey || key===focusedMediaKey || mediaLocks.has(key) || [audioViews.get(key),videoViews.get(key)].some(view=>view?.player.src && view.player.paused===false);}
  function discardMedia(key) {
    const media=mediaUrls.get(key);if(!media) return;
    previewViews.get(key)?.reset();if(audioViews.has(key)) releasePlayer(audioViews.get(key));if(videoViews.has(key)) releasePlayer(videoViews.get(key),true);
    mediaUrls.delete(key);URL.revokeObjectURL(media.url);
  }
  function trimMediaCache(keepKey) {
    let bytes=[...mediaUrls.values()].reduce((sum,media)=>sum+media.cacheBytes,0);
    const candidates=[...mediaUrls.keys()].sort((a,b)=>Number(Boolean(previewViews.get(a)?.visible))-Number(Boolean(previewViews.get(b)?.visible)));
    for(const key of candidates) {if(mediaUrls.size<=MEDIA_CACHE_ENTRIES && bytes<=MEDIA_CACHE_BYTES) break;if(key===keepKey || protectedMedia(key)) continue;bytes-=mediaUrls.get(key).cacheBytes;discardMedia(key);}
  }
  function clearConversationMedia() {
    cancelTranscriptRequest();if($('voice-text-dialog').open) $('voice-text-dialog').close();
    mediaGeneration++;focusedMediaKey=null;previewObserver?.disconnect();previewQueue=[];previewViews.clear();
    for(const controller of mediaControllers.values()) controller.abort();mediaControllers.clear();mediaRequests.clear();
    for(const view of audioViews.values()) releasePlayer(view);for(const view of videoViews.values()) releasePlayer(view,true);audioViews.clear();videoViews.clear();
    for(const key of mediaUrls.keys()) if(key!==viewerMediaKey && !mediaLocks.has(key)) discardMedia(key);
  }
  function currentPreview(view) {return selected?.jid===view.jid && selection===view.version && previewViews.get(view.key)===view;}
  function queuePreview(view) {if(!currentPreview(view) || view.queued || view.loading || view.hasImage) return;view.queued=true;previewQueue.push(view);pumpPreviews();}
  function pumpPreviews() {
    while(previewActive<2 && previewQueue.length) {
      const view=previewQueue.shift();view.queued=false;if(!currentPreview(view) || !view.visible || view.hasImage) continue;
      previewActive++;view.load().finally(()=>{previewActive--;pumpPreviews();});
    }
  }
  async function fetchMedia(message,jid) {
      const key=jid+'|'+message.id,cached=cachedMedia(key);if(cached) return cached;
      if(mediaRequests.has(key)) return mediaRequests.get(key);
      const generation=mediaGeneration,controller=new AbortController();mediaControllers.set(key,controller);
      const request=(async()=>{
      const result=await api(`/media?jid=${encodeURIComponent(jid)}&id=${encodeURIComponent(message.id)}`,'GET',undefined,100000,AbortSignal.any([controller.signal,AbortSignal.timeout(100000)]));
      if(generation!==mediaGeneration) throw new Error('A conversa foi alterada. Abra o anexo novamente.');
      const raw=result.base64.replace(/^data:[^,]*,/,'');if(!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) throw new Error('Mídia retornada em formato inválido.');
      const bytes=Uint8Array.from(atob(raw),char=>char.charCodeAt(0));
      const previewMime=globalThis.WhatsAppMedia?.previewMime?.(bytes) || null,mimeType=previewMime || result.mimeType,url=URL.createObjectURL(new Blob([bytes],{type:mimeType}));
      const media={url,mimeType,previewMime,bytes,cacheBytes:bytes.byteLength*2,fileName:result.fileName || message.fileName || 'anexo'};mediaUrls.set(key,media);trimMediaCache(key);return media;
      })();mediaRequests.set(key,request);
      try {return await request;}finally {if(mediaRequests.get(key)===request) {mediaRequests.delete(key);mediaControllers.delete(key);}}
  }
  function thumbnailUrl(message) {
    const thumbnail=message.jpegThumbnail;
    if(typeof thumbnail!=='string' || thumbnail.length>350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(thumbnail)) return null;
    try {const header=atob(thumbnail.slice(0,4));if(header.charCodeAt(0)===255 && header.charCodeAt(1)===216 && header.charCodeAt(2)===255) return 'data:image/jpeg;base64,'+thumbnail;}catch {}
    return null;
  }
  function previewCard(message,jid) {
    const key=jid+'|'+message.id,pdf=message.type==='document',sticker=message.type==='sticker';
    const openLabel=pdf?'Abrir PDF':sticker?'Abrir figurinha':'Abrir imagem';
    const card=el('section',sticker?'sticker-card':'attachment-card'),button=el('button','attachment-preview-button',openLabel);
    button.type='button';button.setAttribute('aria-label',openLabel);
    const status=el('p','attachment-preview-status');status.hidden=true;status.setAttribute('role','status');
    const view={key,jid,version:selection,card,visible:!previewObserver,hasImage:false,queued:false,loading:false,load:()=>loadPreview(),reset:()=>{
      view.image?.removeAttribute('src');
      if(sticker) {view.image?.remove();button.hidden=false;}
      view.image=null;view.hasImage=false;button.textContent=openLabel;
    }};
    previewViews.set(key,view);card.dataset.mediaId=message.id;previewTargets.set(card,view);
    const unavailable=()=>{status.textContent=sticker?'Figurinha indisponível. Tente novamente.':'Prévia indisponível. Tente abrir ou baixar a imagem.';status.hidden=false;};
    const showImage=source=>{const image=el('img',sticker?'sticker-preview':'conversation-image-preview');image.src=source;image.alt=sticker?'Figurinha':message.text || 'Imagem da conversa';image.decoding='async';
      image.addEventListener('error',()=>{view.reset();if(source.startsWith('data:')) queuePreview(view);else unavailable();});
      view.image=image;view.hasImage=true;
      if(sticker) {button.hidden=true;card.prepend(image);}else button.replaceChildren(image);
      status.hidden=true;};
    const loadPreview=async()=>{view.loading=true;button.textContent=sticker?'Carregando figurinha…':'Carregando imagem…';try {const media=await fetchMedia(message,jid);if(!currentPreview(view)) return;if(!/^image\/(png|jpeg|gif|webp|avif)$/.test(media.previewMime || '')) throw Error('Formato sem prévia');showImage(media.url);}
      catch {if(currentPreview(view)) {view.reset();unavailable();}}finally {view.loading=false;trimMediaCache();}};
    if(!pdf) {const cached=cachedMedia(key),thumbnail=sticker?null:thumbnailUrl(message);if(cached && /^image\/(png|jpeg|gif|webp|avif)$/.test(cached.previewMime || '')) showImage(cached.url);else if(thumbnail) showImage(thumbnail);if(previewObserver) previewObserver.observe(card);else if(!view.hasImage) queuePreview(view);}
    if(sticker) {button.addEventListener('click',()=>{if(!view.loading) loadPreview();});card.append(button,status);return card;}
    const label=el('span','attachment-caption',message.fileName || (pdf?'Documento PDF':'Imagem da conversa'));
    button.addEventListener('click',async()=>{button.disabled=true;mediaLocks.add(key);const version=selection;
      try {const media=await fetchMedia(message,jid);if(selected?.jid!==jid || selection!==version) return;viewerMediaKey=key;await globalThis.WhatsAppMedia?.open?.(media,pdf?'pdf':'image');if(!$('media-viewer').open) viewerMediaKey=null;}
      catch(error) {if(viewerMediaKey===key && !$('media-viewer').open) viewerMediaKey=null;notice(error.message);}finally {mediaLocks.delete(key);button.disabled=false;trimMediaCache();}
    });card.append(button,label);const download=el('button','text-button attachment-download','Baixar');download.type='button';download.addEventListener('click',()=>downloadMedia(message,jid,download));card.append(download,status);return card;
  }
  async function loadMedia(message,jid,button) {
    button.disabled=true;button.textContent='Carregando…';
    try {
      const result=await fetchMedia(message,jid),url=result.url;
      if(['image','audio','video','sticker'].includes(message.type)) {if(selected?.jid===jid) renderMessages();}
      else {const link=el('a');link.href=url;link.download=result.fileName || message.fileName || 'anexo';document.body.append(link);link.click();link.remove();button.disabled=false;button.textContent='↓ Baixar novamente';}
    } catch(error) {button.disabled=false;button.textContent='Tentar abrir anexo';notice(error.message);}
  }
  async function downloadMedia(message,jid,button) {
    button.disabled=true;try {const result=mediaUrls.get(jid+'|'+message.id) || await fetchMedia(message,jid);const link=el('a');link.href=result.url;link.download=result.fileName || message.fileName || 'video.mp4';document.body.append(link);link.click();link.remove();}catch(error) {notice(error.message);}finally {button.disabled=false;}
  }
  function loadMessages(older=false) {
    const jid=selected?.jid,version=selection;if(!jid) return Promise.resolve();
    // A fila pertence à seleção atual: respostas antigas não podem desfazer o cursor do polling.
    const operation=historyQueue.then(()=>{if(selected?.jid!==jid || selection!==version) return;return fetchMessagesPage(jid,version,older);});
    historyQueue=operation.catch(()=>{});return operation;
  }
  async function fetchMessagesPage(jid,version,older) {
    const nextPage=older?page+1:1;
    const result=await api(`/messages?jid=${encodeURIComponent(jid)}&page=${nextPage}`);
    if(selected?.jid!==jid || version!==selection) return;
    // Mais de uma página pode chegar enquanto a aba está oculta. Retome a paginação antes da lacuna.
    const knownIds=new Set(messages.map(message=>message.id));
    if(!older && knownIds.size && result.messages.length && !result.messages.some(message=>knownIds.has(message.id))) page=1;
    const changed=mergeMessages(result.messages);if(older) page=result.page;pages=result.pages;
    if(changed || !historyLoaded || older) {renderMessages(older,!historyLoaded);historyLoaded=true;}
    if(selected.isGroup) return;
    // Áudio novo pode já estar na fila da transcrição automática: busca o estado para mostrar o texto quando ficar pronto.
    if(changed && historyLoaded && result.messages.some(message=>message.type==='audio' && !latestKnownTranscription(jid,message.id))) loadTranscriptions(jid,version).catch(()=>{});
    const unread=result.messages.filter(message=>!message.fromMe && message.key?.fromMe===false && message.key.remoteJid===jid && !readIds.has(jid+'|'+message.id));
    // Só confirma até a última mensagem quando ela veio nesta página (não ao carregar páginas antigas).
    const lastSeenId=!older && result.messages.some(message=>message.id===selected?.lastMessage?.id)?selected.lastMessage.id:undefined;
    if(!unread.length && lastSeenId && !(selected.unread>0) && document.visibilityState==='visible' && !readIds.has(jid+'|seen|'+lastSeenId)) {
      // Conversa já lida no celular: avisa só que foi aberta (tira da fila "Aguardando"), sem confirmar leitura de novo.
      readIds.add(jid+'|seen|'+lastSeenId);api('/read','POST',{jid,keys:[],lastSeenId}).catch(()=>{});
    }
    // Também limpa a marcação manual de "não lida" quando a conversa é reaberta sem mensagens novas.
    if((unread.length || (lastSeenId && selected.unread>0)) && document.visibilityState==='visible') {
      await api('/read','POST',{jid,keys:unread.map(message=>({...message.key,remoteJid:jid})),...(lastSeenId?{lastSeenId}:{})});
      if(selected?.jid===jid) {unread.forEach(message=>readIds.add(jid+'|'+message.id));const chat=chats.find(item=>item.jid===jid);if(chat) chat.unread=0;renderChats();}
    }
  }
  async function loadContact(jid=selected?.jid) {
    if(!jid) return;const version=selection,detail=await api('/contact?jid='+encodeURIComponent(jid));if(selected?.jid!==jid || version!==selection) return;
    $('contact-status').value=detail.status;$('contact-ai').value=detail.aiMode || 'off';$('contact-labels').value=detail.labels.join(', ');
    const fragment=document.createDocumentFragment();for(const note of detail.notes) {const row=el('article','note');row.append(el('p','',note.text),el('time','',dateTime(note.at)));fragment.append(row);}$('notes').replaceChildren(fragment);
  }
  function contactPhone(chat) {return chat.isGroup?'Grupo do WhatsApp':chat.phone?phoneLabel(chat.phone):chat.jid.endsWith('@lid')?'Identificador privado do WhatsApp':phoneLabel(chat.jid.split('@')[0]);}
  function showSelectedIdentity(chat) {
    $('contact-name').textContent=chat.name;$('contact-phone').textContent=contactPhone(chat);$('contact-avatar').textContent=initials(chat.name);
    $('details-contact-name').textContent=chat.name;$('details-contact-phone').textContent=$('contact-phone').textContent;$('details-contact-avatar').textContent=initials(chat.name);
    globalThis.WhatsAppAvatars?.decorate?.($('contact-avatar'),chat,{eager:true});globalThis.WhatsAppAvatars?.decorate?.($('details-contact-avatar'),chat,{eager:true});
  }
  async function selectChat(chat) {
    if(sending) return;
    if(selected) drafts.set(selected.jid,$('message-text').value);
    clearConversationMedia();
    selected=chat;selection++;editRevision++;historyQueue=Promise.resolve();historyLoaded=false;messages=[];page=1;pages=1;attachment=null;attachmentKind=null;pendingSend=null;$('attachment').value='';$('attachment-info').hidden=true;$('message-text').required=true;$('send-status').textContent='';
    globalThis.WhatsAppMedia?.onAttachment?.(null);
    $('conversation-empty').hidden=true;$('conversation-content').hidden=false;$('contact-empty').hidden=true;$('contact-details').hidden=false;
    $('composer').classList.toggle('group-composer',Boolean(chat.isGroup));
    $('show-contact').hidden=$('contact-flags').hidden=Boolean(chat.isGroup);
    if(chat.isGroup) {$('contact-details').hidden=true;toggleContact(false);}
    $('app-shell').classList.toggle('has-chat',true);
    showSelectedIdentity(chat);$('message-text').value=drafts.get(chat.jid) || '';renderTemplateShortcuts();
    globalThis.WhatsAppFeatures?.onSelectChat?.(chat.isGroup?null:chat);
    globalThis.WhatsAppSchedule?.onSelectChat?.(chat);extras()?.onSelectChat?.(chat);
    renderChats();renderMessages();$('messages').replaceChildren(el('p','muted','Carregando histórico…'));
    $('contact-status').value=chat.status || 'open';$('contact-ai').value=chat.aiMode || 'off';$('contact-labels').value=(chat.labels || []).join(', ');$('notes').replaceChildren();
    try {
      if(chat.isGroup) await loadMessages();
      else {await Promise.all([loadMessages(),loadContact(chat.jid),loadTranscriptions(chat.jid)]);runHooks('open',chat);}
    } catch(error) {notice(error.message);}
  }
  function renderTemplates() {
    $('quick-template').replaceChildren(el('option','','Escolher uma resposta…'));$('quick-template').firstElementChild.value='';
    templates.forEach((template,index)=>{const option=el('option','',template.name);option.value=String(index);$('quick-template').append(option);});
    renderTemplateShortcuts();
  }
  function insertTemplate(template) {
    if(!selected || !template) return;
    $('message-text').value=[$('message-text').value,template.body].filter(Boolean).join('\n');editRevision++;pendingSend=null;$('message-text').focus();
  }
  function renderTemplateShortcuts() {
    $('template-count').textContent=templates.length;
    const fragment=document.createDocumentFragment();
    for(const template of templates) {
      const button=el('button','template-shortcut');button.type='button';button.disabled=!selected;button.title=selected?'Inserir no rascunho':'Selecione uma conversa para inserir esta resposta';
      button.append(el('strong','',template.name),el('small','',template.body));button.addEventListener('click',()=>insertTemplate(template));fragment.append(button);
    }
    if(!templates.length) fragment.append(el('div','template-empty','Suas mensagens mais usadas podem ficar aqui. Adicione uma resposta para começar.'));
    $('template-shortcuts').replaceChildren(fragment);runHooks('select');
  }
  function sync(force=false) {
    if(document.visibilityState==='hidden') return Promise.resolve();
    if(syncing) return force?syncTask.then(()=>sync(true)):syncTask;syncing=true;
    syncTask=(async()=>{
    try {
      const value=await api('/connection');showConnection(value);
      if(value.state==='connected') {
        void syncChatLists(force);
        // Só o que mudou desde a última versão; sem mudança, a lista nem é redesenhada.
        const result=await api('/chats?delta=1'+(chatsVersion?'&since='+encodeURIComponent(chatsVersion):''));
        let changed=true;
        if(Array.isArray(result)) {chats=result;chatsVersion=null;}
        else if(result.full) {chats=result.chats;chatsVersion=result.version;}
        else {
          chatsVersion=result.version;changed=result.changed.length>0 || result.removed.length>0;
          if(changed) {const merged=new Map(chats.map(chat=>[chat.jid,chat]));for(const jid of result.removed) merged.delete(jid);for(const chat of result.changed) merged.set(chat.jid,chat);chats=[...merged.values()].sort((a,b)=>(b.lastMessage?.timestamp || 0)-(a.lastMessage?.timestamp || 0));}
        }
        if(changed) {globalThis.WhatsAppFeatures?.onChats?.(chats.filter(chat=>!chat.isGroup));globalThis.WhatsAppSchedule?.onChats?.(chats);}
        if(selected) {const updated=chats.find(chat=>chat.jid===selected.jid);if(updated) {const identityChanged=selected.name!==updated.name || contactPhone(selected)!==contactPhone(updated);Object.assign(selected,updated);if(identityChanged) showSelectedIdentity(selected);}}
        if(changed) renderChats();runHooks('sync');if($('forward-dialog').open) renderForwardDestinations();if(selected && !sending) await loadMessages();$('sync-time').textContent=time(Date.now());
      } else if(!selected) renderChats();
    } catch(error) {notice(error.message);}finally {syncing=false;}
    })();return syncTask;
  }
  async function syncContactNames() {
    if(namesSyncing || connection?.state!=='connected') return;namesSyncing=true;
    for(const id of ['sync-contact-names','panel-sync-contact-names']) {$(id).disabled=true;$(id).textContent='Atualizando nomes…';}
    try {const result=await api('/contacts/sync','POST',{});await sync(true);notice(result.error || `Nomes do WhatsApp atualizados: ${result.named || 0} de ${result.total || 0} contatos com nome.`,!result.error);}
    catch(error) {notice(error.message);}
    finally {namesSyncing=false;for(const id of ['sync-contact-names','panel-sync-contact-names']) {$(id).disabled=connection?.state!=='connected';$(id).textContent='Atualizar nomes do WhatsApp';}}
  }
  for(const id of ['sync-contact-names','panel-sync-contact-names']) $(id).addEventListener('click',syncContactNames);
  async function refreshQr() {
    if(qrBusy || !$('qr-dialog').open) return;qrBusy=true;$('renew-qr').disabled=true;$('connect').disabled=true;
    clearTimeout(qrTimer);
    try {
      const result=await api('/connect','POST',{});
      if(!$('qr-dialog').open) return;
      if(result.state==='connected') {showConnection(result);await sync();return;}
      if(result.base64) {$('qr-image').src=result.base64;$('qr-image').hidden=false;$('qr-status').textContent='Aponte a câmera do celular para este QR Code.';}
      else {$('qr-image').hidden=true;$('qr-image').removeAttribute('src');$('qr-status').textContent='Preparando QR Code. Aguarde alguns segundos…';}
      qrTimer=setTimeout(refreshQr,result.base64?20000:3000);
    } catch(error) {$('qr-image').hidden=true;$('qr-status').textContent=error.message;qrTimer=setTimeout(refreshQr,8000);}
    finally {qrBusy=false;$('renew-qr').disabled=false;$('connect').disabled=!connection?.reachable;}
  }
  function openQr() {if($('connection-dialog').open) $('connection-dialog').close();if(!$('qr-dialog').open) $('qr-dialog').showModal();$('qr-status').textContent='Gerando seu QR Code…';refreshQr();}
  $('connect').addEventListener('click',openQr);$('renew-qr').addEventListener('click',refreshQr);
  $('qr-dialog').addEventListener('close',()=>{clearTimeout(qrTimer);$('qr-image').hidden=true;$('qr-image').removeAttribute('src');});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
  $('refresh').addEventListener('click',()=>{notice('');sync();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') sync();});
  $('disconnect').addEventListener('click',async()=>{
    if(!confirm('Desconectar este computador do WhatsApp? Para usar novamente será necessário ler outro QR Code. O histórico salvo será mantido.')) return;
    $('disconnect').disabled=true;
    try {await api('/disconnect','POST',{});await sync();notice('Conta desconectada. A sessão foi encerrada no conector.');}catch(error) {notice(error.message);}finally {$('disconnect').disabled=false;}
  });
  for(const id of ['search','unread-only','status-filter']) $(id).addEventListener(id==='search'?'input':'change',renderChats);
  $('older').addEventListener('click',async()=>{$('older').disabled=true;try {await loadMessages(true);}catch(error) {notice(error.message);}finally {$('older').disabled=false;}});
  $('quick-template').addEventListener('change',()=>{if($('quick-template').value==='') return;insertTemplate(templates[Number($('quick-template').value)]);$('quick-template').value='';});
  $('message-text').addEventListener('input',()=>{editRevision++;pendingSend=null;if(selected && !selected.isGroup) extras()?.onTyping?.(selected.jid);});
  $('message-text').addEventListener('keydown',event=>{if(event.key==='Enter' && !event.shiftKey && !event.altKey && !event.isComposing && event.keyCode!==229 && !event.repeat) {event.preventDefault();$('composer').requestSubmit();}});
  function setAttachment(file,kind=null,viewOnce=false) {
    if(selected?.isGroup) return;
    if(sending) return;
    editRevision++;pendingSend=null;
    if(file?.size>10*1024*1024) {notice('Escolha um arquivo de até 10 MB.');$('attachment').value='';return;}
    cancelTranscriptRequest();
    attachment=file || null;attachmentKind=kind;$('attachment-name').textContent=file?(kind==='sticker'?'Figurinha · ':'')+file.name+' · '+(file.size/1024).toFixed(0)+' KB':'';$('attachment-info').hidden=!file || Boolean(file.type?.startsWith('audio/'));$('message-text').required=!attachment;if(file) $('message-text').focus();
    globalThis.WhatsAppMedia?.onAttachment?.(attachment,kind,viewOnce);extras()?.onAttachment?.(attachment,kind);
  }
  $('attachment').addEventListener('change',()=>{const kind=attachmentSelectionKind;attachmentSelectionKind=null;setAttachment($('attachment').files[0],kind);});
  $('attachment').addEventListener('cancel',()=>{attachmentSelectionKind=null;});
  $('attachment-toggle').addEventListener('click',()=>{if(selected) $('attachment-dialog').showModal();else notice('Abra uma conversa para anexar um arquivo.');});
  for(const [id,accept,kind] of [['attach-media','image/*,video/*',null],['attach-audio','audio/*',null],['attach-document','','document']]) $(id).addEventListener('click',()=>{$('attachment-dialog').close();attachmentSelectionKind=kind;$('attachment').accept=accept;$('attachment').click();});
  $('attach-sticker').addEventListener('click',()=>{$('attachment-dialog').close();$('sticker-file').click();});
  $('sticker-file').addEventListener('change',()=>{const file=$('sticker-file').files[0];if(!file) return;if(!['image/webp','image/png','image/jpeg'].includes(file.type) || file.size>1024*1024) {notice('Escolha uma figurinha WEBP, PNG ou JPG de até 1 MB.');return;}setAttachment(file,'sticker');$('sticker-file').value='';});
  const emojiNames=[['😀','Sorriso'],['😊','Feliz'],['😂','Rindo'],['😍','Apaixonado'],['🥰','Carinho'],['😎','Óculos'],['🤔','Pensando'],['😅','Alívio'],['😢','Triste'],['😮','Surpresa'],['👍','Positivo'],['👎','Negativo'],['👋','Olá'],['🙏','Obrigado'],['👏','Palmas'],['🤝','Acordo'],['❤️','Coração'],['💚','Coração verde'],['🎉','Festa'],['✅','Confirmado'],['✨','Brilho'],['🔥','Fogo'],['📦','Pacote'],['📅','Agenda'],['✈️','Avião'],['💬','Conversa'],['☀️','Sol'],['🌙','Lua']];
  for(const [emoji,label] of emojiNames) {const button=el('button','emoji-choice',emoji);button.type='button';button.setAttribute('aria-label',label);button.addEventListener('click',()=>{const editor=$('message-text'),start=Number.isInteger(editor.selectionStart)?editor.selectionStart:editor.value.length,end=Number.isInteger(editor.selectionEnd)?editor.selectionEnd:start;editor.value=editor.value.slice(0,start)+emoji+editor.value.slice(end);editRevision++;pendingSend=null;$('emoji-dialog').close();editor.focus();editor.setSelectionRange?.(start+emoji.length,start+emoji.length);});$('emoji-grid').append(button);}
  $('emoji-toggle').addEventListener('click',()=>{$('emoji-dialog').showModal();});
  // Usado por produtos e pelo assistente: coloca texto (e foto) no editor sem enviar nada.
  function insertDraft(text,file) {
    if(!selected) return false;
    $('message-text').value=[$('message-text').value,text].filter(Boolean).join('\n');editRevision++;pendingSend=null;
    if(file) setAttachment(file);
    $('message-text').focus();return true;
  }
  $('remove-attachment').addEventListener('click',()=>setAttachment(null));
  const fileBase64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(file);});
  function cancelTranscriptRequest() {
    if(!transcriptRequest) return;
    transcriptRequest.abort();transcriptRequest=null;
    $('voice-send-text').disabled=false;$('send-status').textContent='';
  }
  $('voice-send-text').addEventListener('click',async()=>{
    if(globalThis.WhatsAppMedia?.isRecording?.()) {globalThis.WhatsAppMedia.stopForText();return;}
    const file=attachment,jid=selected?.jid,button=$('voice-send-text');
    if(!jid || !file || button.hidden || sending || transcriptRequest) return;
    const controller=new AbortController();transcriptRequest=controller;
    button.disabled=true;$('send-status').textContent='Preparando a prévia do texto…';
    try {
      const base64=await fileBase64(file);
      if(controller.signal.aborted) return;
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(22*60_000)]);
      const {text}=await api('/voice/transcribe-draft','POST',{jid,base64,mimeType:file.type || 'audio/webm'},undefined,signal);
      if(transcriptRequest!==controller || globalThis.WhatsAppMedia?.viewOnce?.()) return;
      $('voice-text-preview').value=text;$('voice-text-status').textContent='';$('voice-text-dialog').showModal();
    } catch(error) {if(transcriptRequest===controller) $('send-status').textContent=error.message;}
    finally {
      if(transcriptRequest===controller) {
        transcriptRequest=null;button.disabled=false;
        if($('send-status').textContent==='Preparando a prévia do texto…') $('send-status').textContent='';
      }
    }
  });
  $('voice-text-cancel').addEventListener('click',()=>$('voice-text-dialog').close());
  $('voice-text-dialog').addEventListener('cancel',event=>{if(sending) event.preventDefault();});
  async function sendMessage(event) {
    event.preventDefault();if(!selected || (!selected.isGroup && $('speak-send').disabled)) return;
    const asText=event.currentTarget===$('voice-text-form'),status=$(asText?'voice-text-status':'send-status');
    // Enter durante um envio não se perde: a próxima mensagem sai assim que a atual terminar.
    if(sending) {if(!asText) submitQueued=true;return;}
    if(connection?.state!=='connected') {status.textContent='WhatsApp desconectado. A mensagem continua disponível para envio.';return;}
    if(globalThis.WhatsAppMedia?.isRecording?.()) {notice('Pare a gravação para ouvir e enviar o áudio.');return;}
    const jid=selected.jid,text=$(asText?'voice-text-preview':'message-text').value.trim(),file=attachment,kind=attachmentKind;
    let submittedRevision=editRevision,cleared=false,sent=false;
    if(asText && (!file || !text || !$('voice-text-dialog').open)) {status.textContent='Escreva o texto que deseja enviar.';return;}
    if(!file && !text) return;
    const mediaType=!file || kind==='sticker' || kind==='document'?'document':file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':kind==='voice' || file.type.startsWith('audio/')?'audio':'document';
    const viewOnce=Boolean(file && globalThis.WhatsAppMedia?.viewOnce?.());
    if(asText && (mediaType!=='audio' || viewOnce)) return;
    const voice=!asText && (kind==='voice' || (mediaType==='audio' && viewOnce));
    const route=asText || !file?'/send':voice?'/send-voice':kind==='sticker'?'/send-sticker':'/send-media';
    const preserveDraft=voice || asText;
    const mediaControls=['voice-send','voice-send-text','voice-cancel','remove-attachment','attachment-toggle','voice-view-once','attachment-view-once','voice-text-confirm','voice-text-cancel'];
    cancelTranscriptRequest();
    sending=true;$('send').disabled=true;
    for(const id of mediaControls) $(id).disabled=true;
    status.textContent='Enviando…';
    try {
      let submitted=pendingSend?.route===route && pendingSend.asText===asText && (!asText || pendingSend.input.text===text)?pendingSend:null;
      if(!submitted) {
        const requestId=crypto.randomUUID();
        if(file && kind==='sticker' && text) throw new Error('Figurinhas não têm legenda. Remova o texto ou envie-o separadamente.');
        const quotedId=extras()?.replyFor?.(jid) || undefined,quote=quotedId && kind!=='sticker'?{quotedId}:{};
        const options=viewOnce?{viewOnce:true}:{};
        if(voice) submitted={route,asText,input:{jid,base64:await fileBase64(file),mimeType:file.type || 'audio/webm',requestId,...quote,...options}};
        else if(file && !asText) submitted={route,asText,input:{jid,caption:text,base64:await fileBase64(file),fileName:file.name,mimeType:file.type || 'application/octet-stream',mediaType,requestId,...quote,...options}};
        else submitted={route,asText,input:{jid,text,requestId,...quote}};
        if(editRevision===submittedRevision) pendingSend=submitted;
      }
      // O editor esvazia já no envio: o que for digitado enquanto o conector responde é a próxima mensagem, não sobra da anterior.
      if(!preserveDraft && editRevision===submittedRevision) {$('message-text').value='';drafts.delete(jid);editRevision++;submittedRevision=editRevision;cleared=true;}
      const message=await api(route,'POST',submitted.input,file && !asText?120000:30000);if(pendingSend===submitted) pendingSend=null;
      sent=true;
      if(selected?.jid===jid && message?.id && message.fromMe===true) {
        mergeMessages([{...message,timestamp:message.timestamp || Date.now()}]);renderMessages();
      }
      if(asText) $('voice-text-dialog').close();
      if(file && attachment===file) {attachment=null;attachmentKind=null;$('attachment').value='';$('attachment-info').hidden=true;$('message-text').required=true;globalThis.WhatsAppMedia?.onAttachment?.(null);}
      extras()?.onSent?.(jid);
      $('send-status').textContent=asText?'Transcrição enviada como mensagem de texto.':voice?'Mensagem de voz aceita pelo conector.'+(text?' O texto continua no editor.':''):'Mensagem aceita pelo conector. O status será atualizado no histórico.';
    } catch(error) {
      status.textContent=error.message+' Confira a conversa antes de tentar outro envio.';
      // Falhou: o texto volta ao editor da conversa certa, sem apagar o que já foi digitado depois.
      if(cleared && !sent) {
        if(selected?.jid===jid) {const typed=$('message-text').value;$('message-text').value=typed?text+'\n'+typed:text;if(typed) {editRevision++;pendingSend=null;}}
        else if(!drafts.get(jid)) drafts.set(jid,text);
      }
    }
    finally {
      sending=false;$('send').disabled=connection?.state!=='connected';
      for(const id of mediaControls) $(id).disabled=false;
    }
    if(sent) await loadMessages().catch(()=>{});
    if(submitQueued) {submitQueued=false;if(sent) $('composer').requestSubmit();}
  }
  $('composer').addEventListener('submit',sendMessage);
  $('voice-text-form').addEventListener('submit',sendMessage);
  $('new-chat').addEventListener('click',()=>{$('new-error').textContent='';$('new-dialog').showModal();});
  $('new-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {const chat=await api('/resolve-phone','POST',{phone:$('new-phone').value});$('new-dialog').close();await selectChat({...chat,status:'open',labels:[],unread:0});}catch(error) {$('new-error').textContent=error.message;}finally {button.disabled=false;}
  });
  function toggleContact(value) {detailsOpen=value;$('app-shell').classList.toggle('details-open',detailsOpen);$('show-contact').setAttribute('aria-expanded',String(detailsOpen));}
  function showPanel(section) {
    for(const name of ['attendance','products','assistant','templates','connection']) {$('tab-'+name).classList.toggle('active',name===section);$('tab-'+name).setAttribute('aria-selected',String(name===section));$(name==='attendance'?'attendance-section':name+'-section').hidden=name!==section;}
  }
  const navIds=['nav-overview','nav-conversations','nav-contacts','nav-pending','nav-closed','nav-knowledge','nav-products','nav-ai','nav-team','nav-voice','nav-profile','settings','nav-connection','nav-settings'];
  const pageIds=['page-dashboard','page-contacts','page-knowledge','page-products','page-ai','page-team','page-voice','page-profile'];
  function renderDashboard() {
    const cards=document.createDocumentFragment(),activeChats=chats.filter(chat=>!chat.isGroup && chat.archived!==true);
    for(const [label,count,status,unread] of [
      ['Conversas',activeChats.length,'',false],['Não lidas',activeChats.filter(c=>c.unread>0 || c.markedUnread===true).length,'',true],
      ['Pendentes',activeChats.filter(c=>c.status==='pending').length,'pending',false],
      ['Concluídas',activeChats.filter(c=>c.status==='closed').length,'closed',false]]) {
      const card=el('button','panel dashboard-stat');card.type='button';
      card.append(el('span','muted',label),el('strong','',String(count)));
      card.addEventListener('click',()=>applyFilter(status,unread));cards.append(card);
    }
    $('dashboard-stats').replaceChildren(cards);
    $('dashboard-connection').textContent=connection?.state==='connected'?'WhatsApp conectado':'WhatsApp desconectado';
    const recent=document.createDocumentFragment();
    for(const chat of activeChats.sort((a,b)=>(b.lastMessage?.timestamp||0)-(a.lastMessage?.timestamp||0)).slice(0,8)) {
      const row=el('button','dashboard-row');row.type='button';
      const copy=el('span');copy.append(el('strong','',chat.name),el('small','muted',chat.lastMessage?.text || 'Sem mensagem recente'));
      row.append(copy,el('span','muted',statuses[chat.status] || 'Em aberto'));
      row.addEventListener('click',()=>openChat(chat));recent.append(row);
    }
    if(!activeChats.length) recent.append(el('p','muted',chats.length?'Nenhuma conversa ativa.':'Nenhuma conversa sincronizada. Conecte seu WhatsApp para começar.'));
    $('dashboard-recent').replaceChildren(recent);
    const attention=activeChats.filter(chat=>chat.status!=='closed' && (chat.unread>0 || chat.status==='pending'));
    $('dashboard-summary').textContent=attention.length?`${attention.length} conversa(s) precisam da sua atenção. Vamos organizar o dia?`:'Sua fila está em dia. Acompanhe a atividade da sua central.';
    $('dashboard-updated').textContent='Atualizado às '+time(Date.now());
    $('dashboard-attention-count').textContent=String(attention.length);
    const queue=document.createDocumentFragment();
    for(const chat of [...attention].sort((a,b)=>(b.unread||0)-(a.unread||0)).slice(0,5)) {
      const row=el('button','dashboard-row');row.type='button';
      const copy=el('span');copy.append(el('strong','',chat.name),el('small','muted',chat.unread>0?`${chat.unread} mensagem(ns) não lida(s)`:'Aguardando continuidade'));
      row.append(copy,el('span','dashboard-chip attention',chat.unread>0?'Responder ↗':'Retomar ↗'));
      row.addEventListener('click',()=>openChat(chat));queue.append(row);
    }
    if(!attention.length) queue.append(el('p','dashboard-empty',chats.length?'Tudo em dia por aqui. Nenhuma conversa nesta fila.':'Conecte sua conta e sincronize as conversas para acompanhar sua fila.'));
    $('dashboard-attention').replaceChildren(queue);
    const distribution=document.createDocumentFragment();
    for(const [status,label] of Object.entries(statuses)) {
      const count=chats.filter(chat=>chat.status===status).length;
      const item=el('div','dashboard-distribution-item'),head=el('div','dashboard-distribution-label');head.append(el('span','',label),el('strong','',String(count)));
      const meter=el('progress','dashboard-progress '+status);meter.max=chats.length || 1;meter.value=count;meter.setAttribute('aria-label',label+': '+count);
      item.append(head,meter);distribution.append(item);
    }
    $('dashboard-distribution').replaceChildren(distribution);
    const modes=document.createDocumentFragment();
    for(const [mode,label] of [['auto','Modo automático'],['draft','Rascunhos assistidos'],['off','Atendimento manual']]) {
      const item=el('div','dashboard-distribution-label');item.append(el('span','muted',label),el('strong','',String(chats.filter(chat=>mode==='off'?!['auto','draft'].includes(chat.aiMode):chat.aiMode===mode).length)));modes.append(item);
    }
    $('dashboard-ai-summary').replaceChildren(modes);

  }
  $('dashboard-ai-open').addEventListener('click',()=>showView('page-ai','nav-ai'));
  hooks.sync.push(renderDashboard);
  function showView(view='workspace',nav) {
    const workspace=view==='workspace';$('metrics').hidden=!workspace;$('workspace').hidden=!workspace;
    for(const id of pageIds) $(id).hidden=id!==view;
    if(nav) setNavigation(nav);
    runHooks('view',view);
  }
  function openChat(chat) {showView('workspace','nav-conversations');return selectChat(chat);}
  function setNavigation(id) {for(const name of navIds) {$(name).classList.toggle('active',name===id);if(name===id) $(name).setAttribute('aria-current','page');else $(name).removeAttribute('aria-current');}}
  function resetInboxFilters() {
    listFilter='';$('chat-list-filter').value='';
    extras()?.resetFilters?.();globalThis.WhatsAppTeam?.resetFilter?.();
    const title=$('inbox-title').firstChild;if(title) title.textContent='Conversas ';
  }
  function applyFilter(status='',unread=false,nav='nav-conversations',list='') {resetInboxFilters();listFilter=list;$('chat-list-filter').value=list;showView('workspace');$('search').value='';$('status-filter').value=status;$('unread-only').checked=unread;setNavigation(nav);renderChats();}
  $('nav-overview').addEventListener('click',()=>{resetInboxFilters();renderDashboard();showView('page-dashboard','nav-overview');});
  $('nav-conversations').addEventListener('click',()=>{applyFilter();$('search').focus();});
  $('nav-pending').addEventListener('click',()=>applyFilter('pending',false,'nav-pending'));
  $('nav-closed').addEventListener('click',()=>applyFilter('closed',false,'nav-closed'));
  $('metric-total-button').addEventListener('click',()=>applyFilter('',false,'nav-conversations'));
  $('metric-unread-button').addEventListener('click',()=>applyFilter('',true));
  $('metric-pending-button').addEventListener('click',()=>applyFilter('pending',false,'nav-pending'));
  $('metric-closed-button').addEventListener('click',()=>applyFilter('closed',false,'nav-closed'));
  $('filter-all').addEventListener('click',()=>applyFilter());$('filter-pending').addEventListener('click',()=>applyFilter('pending',false,'nav-pending'));
  $('chat-list-filter').addEventListener('change',event=>applyFilter('',false,'nav-conversations',event.target.value));
  $('groups-row').addEventListener('click',()=>applyFilter('',false,'nav-conversations',listFilter==='groups'?'':'groups'));
  $('toggle-filters').addEventListener('click',()=>{$('advanced-filters').hidden=!$('advanced-filters').hidden;$('toggle-filters').setAttribute('aria-expanded',String(!$('advanced-filters').hidden));});
  for(const section of ['attendance','products','assistant','templates','connection']) $('tab-'+section).addEventListener('click',()=>showPanel(section));
  $('nav-connection').addEventListener('click',()=>$('connection-dialog').showModal());
  $('manage-connection').addEventListener('click',()=>$('connection-dialog').showModal());
  $('nav-settings').addEventListener('click',()=>{showView('workspace','nav-settings');showPanel('connection');toggleContact(true);});
  $('refresh-top').addEventListener('click',()=>{notice('');sync(true);});
  $('show-contact').addEventListener('click',()=>{showPanel('attendance');toggleContact(!detailsOpen);});$('hide-contact').addEventListener('click',()=>toggleContact(false));
  $('back-to-chats').addEventListener('click',()=>{if(sending) return;if(selected) drafts.set(selected.jid,$('message-text').value);clearConversationMedia();selection++;selected=null;globalThis.WhatsAppFeatures?.onSelectChat?.(null);globalThis.WhatsAppSchedule?.onSelectChat?.(null);extras()?.onSelectChat?.(null);toggleContact(false);$('app-shell').classList.toggle('has-chat',false);$('contact-empty').hidden=false;$('contact-details').hidden=true;renderTemplateShortcuts();renderChats();});
  $('contact-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!selected) return;const jid=selected.jid,button=event.submitter;button.disabled=true;
    try {const detail=await api('/contact?jid='+encodeURIComponent(jid),'PATCH',{status:$('contact-status').value,aiMode:$('contact-ai').value || undefined,labels:$('contact-labels').value.split(',').map(value=>value.trim()).filter(Boolean)});const chat=chats.find(item=>item.jid===jid);if(chat) Object.assign(chat,detail,{archived:chat.archived});renderChats();notice(detail.surveyError?'Atendimento salvo. '+detail.surveyError:detail.surveySent?'Atendimento salvo e pesquisa de satisfação enviada.':'Atendimento salvo.',!detail.surveyError);}catch(error) {notice(error.message);}finally {button.disabled=false;}
  });
  $('note-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!selected) return;const jid=selected.jid,button=event.submitter;button.disabled=true;
    try {await api('/notes','POST',{jid,text:$('note-text').value});if(selected?.jid===jid) {$('note-text').value='';await loadContact(jid);}}catch(error) {notice(error.message);}finally {button.disabled=false;}
  });
  function addTemplateRow(template={name:'',body:''}) {
    if($('template-list').children.length>=30) return;
    const row=el('div','template-row'),nameLabel=el('label','field','Nome'),name=el('input');name.value=template.name;name.maxLength=80;name.required=true;name.className='template-name';nameLabel.append(name);
    const bodyLabel=el('label','field','Mensagem'),body=el('textarea');body.value=template.body;body.rows=3;body.maxLength=4000;body.required=true;body.className='template-body';bodyLabel.append(body);
    const remove=el('button','text-button','Remover resposta');remove.type='button';remove.addEventListener('click',()=>row.remove());row.append(nameLabel,bodyLabel,remove);$('template-list').append(row);
  }
  function openSettings() {$('settings-error').textContent='';$('template-list').replaceChildren();templates.forEach(addTemplateRow);$('settings-dialog').showModal();}
  $('settings').addEventListener('click',openSettings);$('configure-templates').addEventListener('click',openSettings);
  $('add-template').addEventListener('click',()=>addTemplateRow());
  $('settings-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {const result=await api('/settings','PATCH',{templates:[...$('template-list').children].map(row=>({name:row.querySelector('.template-name').value,body:row.querySelector('.template-body').value}))});templates=result.templates;renderTemplates();$('settings-dialog').close();notice('Respostas rápidas salvas.',true);}catch(error) {$('settings-error').textContent=error.message;}finally {button.disabled=false;}
  });
  function fillTranscriptionSettings() {
    if(!transcriptionSettings) return;
    $('transcription-model').value=transcriptionSettings.whisperModel;$('transcription-language').value=transcriptionSettings.language;
    if(transcriptionSettings.engine) $('transcription-engine').value=transcriptionSettings.engine;if(transcriptionSettings.concurrency) $('transcription-concurrency').value=String(transcriptionSettings.concurrency);if(transcriptionSettings.maxQueue) $('transcription-max-queue').value=String(transcriptionSettings.maxQueue);
    if(Number.isFinite(transcriptionSettings.queued)) $('transcription-queue-status').textContent=`Agora: ${transcriptionSettings.running || 0} em andamento, ${transcriptionSettings.queued} na fila. De 10 a 500 áudios aguardando.`;
    $('transcription-key-status').textContent=transcriptionSettings.aiConfigured?'Chave da OpenAI configurada.':'Nenhuma chave da OpenAI configurada.';
    $('remove-transcription-key').disabled=!transcriptionSettings.aiConfigured;
  }
  function loadTranscriptionSettings() {
    if(!transcriptionSettingsLoading) transcriptionSettingsLoading=api('/transcription/settings').then(settings=>{transcriptionSettings=settings;return settings;}).finally(()=>{transcriptionSettingsLoading=null;});
    return transcriptionSettingsLoading;
  }
  let transcriptionQueueBusy=false,transcriptionQueueRefresh=0;
  async function refreshTranscriptionQueue() {
    if(!$('transcription-dialog').open || transcriptionQueueBusy || document.visibilityState==='hidden') return;
    transcriptionQueueBusy=true;
    try {
      const queue=await api('/transcriptions/queue');if(!$('transcription-dialog').open) return;
      const busy=queue.running+queue.queued+queue.drafts>0;
      $('transcription-queue-summary').textContent=`${busy?'Processando áudios':'Fila concluída'} · ${queue.running} em andamento · ${queue.queued} aguardando · ${queue.completed} concluídas · ${queue.failed} com falha`+(queue.drafts?` · ${queue.drafts} prévia(s) de envio`:'');
      if(!busy && !queue.completed && !queue.failed) $('transcription-queue-summary').textContent='Nenhuma transcrição solicitada ainda.';
      $('transcription-queue-progress').hidden=!busy;
      const fragment=document.createDocumentFragment();
      for(const [label,list] of [['Transcrevendo',queue.current],['Na fila',queue.waiting]]) for(const [index,job] of list.entries()) {
        const name=chats.find(chat=>chat.jid===job.jid)?.name || phoneLabel(job.jid.split('@')[0]);
        fragment.append(el('li','',`${label}${label==='Na fila'?' · '+(index+1)+'º':''}: ${name}${job.prioritized?' · Prioridade':''}`));
      }
      $('transcription-queue-items').replaceChildren(fragment);
      $('transcription-queue-card').setAttribute('data-refresh',String(++transcriptionQueueRefresh));
    } catch(error) {$('transcription-queue-summary').textContent='Não foi possível atualizar a fila: '+error.message;$('transcription-queue-progress').hidden=true;}
    finally {transcriptionQueueBusy=false;}
  }
  setInterval(refreshTranscriptionQueue,3000);
  async function openTranscriptionSettings(reason='') {
    $('transcription-settings-status').textContent=reason;$('transcription-settings-error').textContent='';$('transcription-api-key').value='';
    if(!$('transcription-dialog').open) $('transcription-dialog').showModal();
    refreshTranscriptionQueue();
    $('save-transcription-settings').disabled=true;
    try {await loadTranscriptionSettings();if($('transcription-dialog').open) fillTranscriptionSettings();}
    catch(error) {$('transcription-settings-error').textContent=error.message;}
    finally {$('save-transcription-settings').disabled=!transcriptionSettings;}
  }
  $('transcription-settings').addEventListener('click',()=>openTranscriptionSettings());
  $('panel-transcription-settings').addEventListener('click',()=>openTranscriptionSettings());
  $('transcription-dialog').addEventListener('close',()=>{$('transcription-api-key').value='';});
  $('transcription-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('save-transcription-settings');button.disabled=true;$('remove-transcription-key').disabled=true;$('transcription-settings-error').textContent='';
    const aiApiKey=$('transcription-api-key').value.trim();$('transcription-api-key').value='';
    try {
      const queueLimit=Number($('transcription-max-queue').value),parallel=Number($('transcription-concurrency').value);
      transcriptionSettings=await api('/transcription/settings','PATCH',{whisperModel:$('transcription-model').value,language:$('transcription-language').value,...($('transcription-engine').value?{engine:$('transcription-engine').value}:{}),...(Number.isInteger(parallel) && parallel>0?{concurrency:parallel}:{}),...(Number.isInteger(queueLimit) && queueLimit>0?{maxQueue:queueLimit}:{}),...(aiApiKey?{aiApiKey}:{})});
      fillTranscriptionSettings();$('transcription-dialog').close();notice('Configurações de transcrição salvas.',true);
    } catch(error) {$('transcription-settings-error').textContent=error.message;}
    finally {button.disabled=false;fillTranscriptionSettings();}
  });
  $('remove-transcription-key').addEventListener('click',async()=>{
    $('remove-transcription-key').disabled=true;$('save-transcription-settings').disabled=true;$('transcription-api-key').value='';$('transcription-settings-error').textContent='';
    try {transcriptionSettings=await api('/transcription/settings','PATCH',{removeAiKey:true});fillTranscriptionSettings();$('transcription-settings-status').textContent='Chave removida. O Whisper local continua disponível.';}
    catch(error) {$('transcription-settings-error').textContent=error.message;}
    finally {$('save-transcription-settings').disabled=false;fillTranscriptionSettings();}
  });
  globalThis.WhatsAppAccounts?.init?.({api,notice});
  globalThis.WhatsAppAvatars?.init?.({api});
  globalThis.WhatsAppFeatures?.init?.({api,notice,openChat:selectChat,getChats:()=>chats});
  globalThis.WhatsAppSchedule?.init?.({api,notice,getChats:()=>chats,getSelected:()=>selected,getDraft:()=>({text:$('message-text').value,hasAttachment:!!attachment,revision:editRevision}),onScheduled:(job,snapshot)=>{if(selected?.jid===job.jid && !attachment && editRevision===snapshot.revision && $('message-text').value===snapshot.text) {$('message-text').value='';drafts.delete(selected.jid);editRevision++;pendingSend=null;}}});
  globalThis.WhatsAppTriggers?.init?.({api,notice,getChats:()=>chats,getSelected:()=>selected});
  globalThis.WhatsAppMedia?.init?.({notice,setAttachment,getSelected:()=>selected,canRecord:()=>!!selected && !selected.isGroup && !sending && !attachment && connection?.state==='connected',onRecording:(jid,active)=>extras()?.onRecording?.(jid,active),send:()=>$('composer').requestSubmit(),isSending:()=>sending,touchDraft:()=>{editRevision++;pendingSend=null;},hooks});
  $('media-viewer').addEventListener('close',()=>{const key=viewerMediaKey;viewerMediaKey=null;if(key && !key.startsWith((selected?.jid || '')+'|')) discardMedia(key);trimMediaCache();});
  window.addEventListener('pagehide',()=>{viewerMediaKey=null;mediaLocks.clear();clearConversationMedia();});
  const mainNav=document.querySelector('.main-nav');
  if(mainNav?.append) for(const id of ['nav-overview','nav-conversations','nav-contacts','nav-crm','nav-team','nav-products','nav-knowledge','nav-ai','nav-voice','nav-triggers','nav-automation','nav-schedule','settings','transcription-settings','nav-starred','nav-profile','nav-connection','nav-settings','nav-pending','nav-closed']) {const entry=$(id);if(entry) {entry.setAttribute('aria-label',entry.getAttribute('aria-label') || entry.textContent.trim());mainNav.append(entry);}}
  hooks.sync.push(()=>globalThis.WhatsAppTriggers?.onChats?.(chats));hooks.select.push(()=>globalThis.WhatsAppTriggers?.onSelectChat?.(selected));
  (async()=>{try {templates=(await api('/settings')).templates;renderTemplates();}catch(error) {notice(error.message);}await sync();if(new URLSearchParams(location.search).has('conectar') && connection?.reachable && connection.state!=='connected') openQr();})();
  setInterval(sync,4000);
  setInterval(pollTranscriptions,2000);
  // Ponte para pages.js (base de conhecimento, produtos, IA e CRM).
  globalThis.WhatsAppCentral={$,el,api,notice,time,dateTime,initials,phoneLabel,showView,insertDraft,openChat,hooks,chats:()=>chats,selected:()=>selected,connection:()=>connection,
    renderChats,templates:()=>templates,reloadContact:()=>loadContact(),renderMessages:()=>{if(selected) renderMessages(true);},messages:()=>messages,messageRow:id=>messageRows.get(id),previewText,sync:()=>sync(true),loadMessages:()=>loadMessages(),contactPhone,
    touchDraft:()=>{editRevision++;pendingSend=null;},draftText:()=>$('message-text').value,setDraftText:value=>{$('message-text').value=value;editRevision++;pendingSend=null;},isSending:()=>sending,contextSnapshot:()=>({jid:selected?.jid || null,selection,revision:editRevision,lastMessageId:messages.at(-1)?.id || null,lastTextId:messages.filter(message=>message.type==='text'&&!message.deleted&&message.canForward!==false&&message.text?.trim()).at(-1)?.id || null})};
})();
