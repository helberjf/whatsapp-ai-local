(() => {
  'use strict';
  const $=id=>document.getElementById(id),token=document.querySelector('meta[name="whatsapp-session"]')?.content;
  let connection=null,chats=[],selected=null,templates=[],messages=[],page=1,pages=1,selection=0,syncing=false,sending=false,qrTimer=null,qrBusy=false,attachment=null,pendingSend=null,editRevision=0,detailsOpen=false,historyLoaded=false;
  const drafts=new Map(),readIds=new Set(),mediaUrls=new Map(),audioViews=new Map(),messageCopyViews=new Map(),forwardRequestIds=new Map();
  const transcriptionJobs=new Map(),transcriptionChoices=new Map(),transcriptionViews=new Map(),transcriptionErrors=new Map(),transcriptionRequests=new Set(),transcriptionLoads=new Set();
  let transcriptionSettings=null,transcriptionSettingsLoading=null;
  let historyQueue=Promise.resolve(),syncTask=Promise.resolve(),namesSyncing=false,forwardState=null;
  const statuses={open:'Em aberto',pending:'Pendente',closed:'Concluído'};
  const time=value=>value?new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'';
  const dateTime=value=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
  const initials=name=>String(name || '?').split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase();
  const phoneLabel=value=>{const digits=String(value || '').replace(/\D/g,'');return /^55\d{10,11}$/.test(digits)?digits.replace(/^55(\d{2})(\d{4,5})(\d{4})$/,'+55 $1 $2-$3'):digits?'+'+digits:'Nenhuma conta conectada';};
  function el(tag,className,text) {const node=document.createElement(tag);if(className) node.className=className;if(text!==undefined) node.textContent=text;return node;}
  async function api(route,method='GET',input) {
    const response=await fetch('/api'+route,{method,headers:{'X-WhatsApp-Token':token,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(30000)});
    const result=await response.json();if(!response.ok) throw new Error(result.error || 'Não foi possível completar a operação.');return result;
  }
  function notice(message,success=false) {$('notice').textContent=message;$('notice').classList.toggle('success',success);$('notice').hidden=!message;}
  function showConnection(value) {
    connection=value;const online=value.state==='connected';
    $('connection-short').textContent=online?'Conectado':value.state==='connecting'?'Conectando':'Desconectado';$('connection-menu').classList.toggle('connected',online);
    $('connection-heading').textContent=online?'WhatsApp conectado':'Conexão WhatsApp';
    $('connected-phone').textContent=online?phoneLabel(value.phone):'Nenhuma conta conectada';
    $('panel-connection-state').textContent=online?'Conectado':value.state==='connecting'?'Aguardando leitura do QR Code':value.reachable?'Pronto para conectar':'Conector indisponível';
    $('panel-connection-phone').textContent=$('connected-phone').textContent;
    $('sync-label').textContent=online?'Atualização automática':'Aguardando conexão';
    $('connection-badge').textContent=online?'Conectado':value.state==='connecting'?'Aguardando leitura':value.reachable?'Pronto para conectar':'Conector indisponível';
    $('connection-badge').classList.toggle('connected',online);
    $('connection-title').textContent=online?'Seu WhatsApp está conectado':value.reachable?'Conecte sua conta':'Inicie o conector local';
    $('connection-description').textContent=online?`Conta ${value.phone?'+'+value.phone:'conectada'} · sessão salva neste computador.`:value.reachable?'Abra o QR Code aqui e faça a leitura pelo celular.':'Abra Iniciar WhatsApp.cmd e aguarde o Docker ficar pronto.';
    $('connect').hidden=online;$('connect').disabled=!value.reachable || qrBusy;$('disconnect').hidden=!online;
    $('new-chat').disabled=!online;$('send').disabled=!online || sending;
    for(const id of ['sync-contact-names','panel-sync-contact-names']) $(id).disabled=!online || namesSyncing;
    if(online && $('qr-dialog').open) {$('qr-dialog').close();notice('WhatsApp conectado. Suas conversas aparecerão conforme forem sincronizadas.',true);}
  }
  function renderChats() {
    const search=$('search').value.trim().toLocaleLowerCase('pt-BR'),status=$('status-filter').value;
    const filtered=chats.filter(chat=>(!$('unread-only').checked || chat.unread>0) && (!status || chat.status===status) && (!search || `${chat.name} ${chat.phone || ''} ${chat.jid} ${chat.labels.join(' ')}`.toLocaleLowerCase('pt-BR').includes(search)));
    const unreadCount=chats.filter(chat=>chat.unread>0).length,pendingCount=chats.filter(chat=>chat.status==='pending').length;
    $('metric-total').textContent=chats.length;$('metric-unread').textContent=unreadCount;$('metric-pending').textContent=pendingCount;$('metric-closed').textContent=chats.filter(chat=>chat.status==='closed').length;$('chat-count').textContent=filtered.length;
    $('filter-total-count').textContent=chats.length;$('filter-unread-count').textContent=unreadCount;$('nav-pending-count').textContent=pendingCount;
    $('filter-all').classList.toggle('active',!status && !$('unread-only').checked);$('filter-pending').classList.toggle('active',status==='pending');
    $('filter-all').setAttribute('aria-pressed',String(!status && !$('unread-only').checked));$('filter-pending').setAttribute('aria-pressed',String(status==='pending'));
    const fragment=document.createDocumentFragment();
    for(const chat of filtered) {
      const button=el('button','chat-item'+(selected?.jid===chat.jid?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(selected?.jid===chat.jid));
      const avatar=el('span','avatar',initials(chat.name));globalThis.WhatsAppAvatars?.decorate?.(avatar,chat);button.append(avatar);
      const copy=el('span','chat-text'),title=el('span','chat-title');title.append(el('strong','',chat.name));
      if(['pending','closed'].includes(chat.status)) title.append(el('span','chat-status '+chat.status,statuses[chat.status]));
      title.append(el('time','',time(chat.lastMessage?.timestamp)));
      const preview=el('span','chat-preview');preview.append(el('p','',chat.lastMessage?.text || (chat.lastMessage?.type && chat.lastMessage.type!=='text'?'Anexo recebido':statuses[chat.status])));
      if(chat.unread) preview.append(el('span','unread-count',Math.min(chat.unread,999)));
      copy.append(title,preview);button.append(copy);button.addEventListener('click',()=>selectChat(chat));fragment.append(button);
    }
    if(!filtered.length) fragment.append(el('div','list-empty',connection?.state==='connected'?(chats.length?'Nenhuma conversa corresponde a estes filtros.':'Nenhuma conversa por aqui ainda. Use ＋ para abrir um atendimento.'):'Conecte seu WhatsApp para carregar as conversas.'));
    $('chat-list').replaceChildren(fragment);
  }
  function mergeMessages(records) {const all=new Map(messages.map(item=>[item.id,item]));let changed=false;for(const message of records) {if(JSON.stringify(all.get(message.id))!==JSON.stringify(message)) changed=true;all.set(message.id,message);}messages=[...all.values()].sort((a,b)=>a.timestamp-b.timestamp);return changed;}
  const transcriptionKey=(jid,messageId)=>jid+'|'+messageId;
  const pendingTranscription=job=>job && ['queued','running'].includes(job.status);
  function latestTranscription(jid,messageId,provider) {
    return [...(transcriptionJobs.get(jid)?.values() || [])].filter(job=>job.messageId===messageId && job.provider===provider)
      .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  }
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
    const provider=view.provider.value,key=transcriptionKey(view.jid,view.messageId),job=latestTranscription(view.jid,view.messageId,provider),error=transcriptionErrors.get(key+'|'+provider);
    const busy=transcriptionRequests.has(key+'|'+provider),pending=pendingTranscription(job),failed=job?.status==='failed' || Boolean(error);
    view.button.disabled=busy || pending;view.provider.disabled=busy;
    view.button.textContent=busy?'Solicitando…':pending?'Transcrevendo…':failed?'Tentar novamente':'Transcrever';
    view.disclosure.hidden=provider!=='ai';
    const source=provider==='ai'?'IA · OpenAI':'Whisper local';
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
    if(!jid || document.visibilityState==='hidden' || ![...(transcriptionJobs.get(jid)?.values() || [])].some(pendingTranscription)) return;
    try {await loadTranscriptions(jid,version);}catch(error) {if(selected?.jid===jid && selection===version) notice('Não foi possível atualizar as transcrições: '+error.message);}
  }
  const audioTime=value=>Number.isFinite(value) && value>=0?Math.floor(value/60)+':'+String(Math.floor(value%60)).padStart(2,'0'):'--:--';
  function audioCard(message,jid) {
    const key=jid+'|'+message.id;if(audioViews.has(key)) return audioViews.get(key).card;
    const card=el('section','audio-card'),heading=el('div','audio-heading'),load=el('button','audio-load','▶ Carregar áudio'),clock=el('span','audio-time','0:00 / --:--'),player=el('audio','audio-player'),speed=el('select','audio-speed'),status=el('p','audio-status');
    card.setAttribute('aria-label','Mensagem de áudio');load.type='button';load.title='Carregar o áudio para ouvir';clock.setAttribute('aria-label','Tempo reproduzido e duração');
    player.controls=true;player.preload='none';player.hidden=true;player.setAttribute('aria-label','Reproduzir mensagem de áudio');
    speed.setAttribute('aria-label','Velocidade de reprodução');speed.disabled=true;
    for(const rate of ['1','1.5','2']) {const option=el('option','',rate+'×');option.value=rate;speed.append(option);}speed.value='1';
    status.setAttribute('role','status');status.hidden=true;
    const view={card,load,clock,player,speed,status,loading:false};audioViews.set(key,view);
    const updateTime=()=>{clock.textContent=audioTime(player.currentTime || 0)+' / '+audioTime(player.duration);};
    for(const event of ['loadedmetadata','durationchange','timeupdate','ended']) player.addEventListener(event,updateTime);
    speed.addEventListener('change',()=>{player.playbackRate=Number(speed.value);});
    player.addEventListener('error',()=>{status.textContent='Não foi possível reproduzir este formato de áudio. Tente carregar novamente.';status.hidden=false;load.hidden=false;load.disabled=false;load.textContent='↻ Carregar novamente';});
    load.addEventListener('click',async()=>{
      if(view.loading) return;view.loading=true;load.disabled=true;load.textContent='Carregando áudio…';status.hidden=true;
      try {const media=await fetchMedia(message,jid);player.src=media.url;player.hidden=false;speed.disabled=false;load.hidden=true;load.textContent='▶ Carregar áudio';}
      catch(error) {status.textContent=error.message;status.hidden=false;load.textContent='↻ Tentar carregar áudio';}
      finally {view.loading=false;load.disabled=false;}
    });
    heading.append(load,clock,speed);card.append(heading,player,status);return card;
  }
  function messageCopyText(message,jid) {
    if(message.text || message.caption) return message.text || message.caption;
    if(message.type!=='audio') return '';
    const provider=transcriptionChoices.get(transcriptionKey(jid,message.id)) || 'whisper';
    const preferred=latestTranscription(jid,message.id,provider);
    if(preferred?.status==='completed' && preferred.text) return preferred.text;
    return [...(transcriptionJobs.get(jid)?.values() || [])].filter(job=>job.messageId===message.id && job.status==='completed' && job.text).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.text || '';
  }
  function messageActions(message,jid) {
    const menu=el('details','message-actions'),toggle=el('summary','message-menu-toggle','⌄'),options=el('div','message-menu'),forward=el('button','message-forward','Encaminhar'),copy=el('button','message-copy','Copiar texto');
    toggle.setAttribute('aria-label','Opções da mensagem');forward.type='button';forward.disabled=message.canForward===false;if(forward.disabled) forward.title='Este tipo de mensagem não pode ser encaminhado.';copy.type='button';copy.disabled=!messageCopyText(message,jid);
    messageCopyViews.set(jid+'|'+message.id,{jid,message,button:copy});
    forward.addEventListener('click',()=>{if(message.canForward===false) return;menu.open=false;openForward(message,jid);});
    copy.addEventListener('click',async()=>{const text=messageCopyText(message,jid);if(!text) return;menu.open=false;try {await navigator.clipboard.writeText(text);notice('Texto copiado.',true);}catch {notice('Não foi possível copiar. Selecione o texto da mensagem para copiar.');}});
    options.append(forward,copy);menu.append(toggle,options);return menu;
  }
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
    const fragment=document.createDocumentFragment();transcriptionViews.clear();messageCopyViews.clear();
    for(const message of messages) {
      const row=el('article','message'+(message.fromMe?' mine':''));
      if(message.type==='audio') row.append(audioCard(message,selected.jid));
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
      if(message.text) row.append(el('p','',message.text));
      if(message.type==='audio') row.append(audioTranscription(message,selected.jid));
      const ack=!message.fromMe?'': ['READ','PLAYED',4,5].includes(message.status)?' · Lida':['DELIVERY_ACK','DELIVERED',3].includes(message.status)?' · Entregue':['ERROR','FAILED',0].includes(message.status)?' · Falha':['PENDING',1].includes(message.status)?' · Enviando':' · Enviada';
      row.append(messageActions(message,selected.jid));const meta=el('time','message-meta',time(message.timestamp)+ack);if(message.timestamp) meta.title=dateTime(message.timestamp);row.append(meta);fragment.append(row);
    }
    if(!messages.length) fragment.append(el('p','muted','Ainda não há mensagens sincronizadas nesta conversa.'));
    container.replaceChildren(fragment);$('older').hidden=page>=pages;$('history-info').textContent=messages.length?`${messages.length} mensagens carregadas`:'';
    if(keepScroll) container.scrollTop=oldTop+container.scrollHeight-oldHeight;
    else if(nearBottom || forceBottom) container.scrollTop=container.scrollHeight;
  }
  async function fetchMedia(message,jid) {
      const result=await api(`/media?jid=${encodeURIComponent(jid)}&id=${encodeURIComponent(message.id)}`);
      const raw=result.base64.replace(/^data:[^,]*,/,'');if(!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) throw new Error('Mídia retornada em formato inválido.');
      const bytes=Uint8Array.from(atob(raw),char=>char.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:result.mimeType}));
      const key=jid+'|'+message.id;if(mediaUrls.has(key)) URL.revokeObjectURL(mediaUrls.get(key).url);mediaUrls.set(key,{url});
      return {url,fileName:result.fileName};
  }
  async function loadMedia(message,jid,button) {
    button.disabled=true;button.textContent='Carregando…';
    try {
      const result=await fetchMedia(message,jid),url=result.url;
      if(['image','audio','video','sticker'].includes(message.type)) {if(selected?.jid===jid) renderMessages();}
      else {const link=el('a');link.href=url;link.download=result.fileName || message.fileName || 'anexo';document.body.append(link);link.click();link.remove();button.disabled=false;button.textContent='↓ Baixar novamente';}
    } catch(error) {button.disabled=false;button.textContent='Tentar abrir anexo';notice(error.message);}
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
    const unread=result.messages.filter(message=>!message.fromMe && message.key?.fromMe===false && message.key.remoteJid===jid && !readIds.has(jid+'|'+message.id));
    if(unread.length && document.visibilityState==='visible') {
      await api('/read','POST',{jid,keys:unread.map(message=>message.key)});
      if(selected?.jid===jid) {unread.forEach(message=>readIds.add(jid+'|'+message.id));const chat=chats.find(item=>item.jid===jid);if(chat) chat.unread=0;renderChats();}
    }
  }
  async function loadContact(jid=selected?.jid) {
    if(!jid) return;const version=selection,detail=await api('/contact?jid='+encodeURIComponent(jid));if(selected?.jid!==jid || version!==selection) return;
    $('contact-status').value=detail.status;$('contact-labels').value=detail.labels.join(', ');
    const fragment=document.createDocumentFragment();for(const note of detail.notes) {const row=el('article','note');row.append(el('p','',note.text),el('time','',dateTime(note.at)));fragment.append(row);}$('notes').replaceChildren(fragment);
  }
  function contactPhone(chat) {return chat.phone?phoneLabel(chat.phone):chat.jid.endsWith('@lid')?'Identificador privado do WhatsApp':phoneLabel(chat.jid.split('@')[0]);}
  function showSelectedIdentity(chat) {
    $('contact-name').textContent=chat.name;$('contact-phone').textContent=contactPhone(chat);$('contact-avatar').textContent=initials(chat.name);
    $('details-contact-name').textContent=chat.name;$('details-contact-phone').textContent=$('contact-phone').textContent;$('details-contact-avatar').textContent=initials(chat.name);
    globalThis.WhatsAppAvatars?.decorate?.($('contact-avatar'),chat,{eager:true});globalThis.WhatsAppAvatars?.decorate?.($('details-contact-avatar'),chat,{eager:true});
  }
  async function selectChat(chat) {
    if(sending) return;
    if(selected) drafts.set(selected.jid,$('message-text').value);
    selected=chat;selection++;editRevision++;historyQueue=Promise.resolve();historyLoaded=false;messages=[];page=1;pages=1;attachment=null;pendingSend=null;$('attachment').value='';$('attachment-info').hidden=true;$('message-text').required=true;$('send-status').textContent='';
    $('conversation-empty').hidden=true;$('conversation-content').hidden=false;$('contact-empty').hidden=true;$('contact-details').hidden=false;
    $('app-shell').classList.toggle('has-chat',true);
    showSelectedIdentity(chat);$('message-text').value=drafts.get(chat.jid) || '';renderTemplateShortcuts();
    globalThis.WhatsAppFeatures?.onSelectChat?.(chat);
    globalThis.WhatsAppSchedule?.onSelectChat?.(chat);
    renderChats();renderMessages();$('messages').replaceChildren(el('p','muted','Carregando histórico…'));
    $('contact-status').value=chat.status || 'open';$('contact-labels').value=(chat.labels || []).join(', ');$('notes').replaceChildren();
    try {await Promise.all([loadMessages(),loadContact(chat.jid),loadTranscriptions(chat.jid)]);}catch(error) {notice(error.message);}
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
    $('template-shortcuts').replaceChildren(fragment);
  }
  function sync(force=false) {
    if(document.visibilityState==='hidden') return Promise.resolve();
    if(syncing) return force?syncTask.then(()=>sync()):syncTask;syncing=true;
    syncTask=(async()=>{
    try {
      const value=await api('/connection');showConnection(value);
      if(value.state==='connected') {
        chats=await api('/chats');globalThis.WhatsAppFeatures?.onChats?.(chats);globalThis.WhatsAppSchedule?.onChats?.(chats);
        if(selected) {const updated=chats.find(chat=>chat.jid===selected.jid);if(updated) {const identityChanged=selected.name!==updated.name || contactPhone(selected)!==contactPhone(updated);Object.assign(selected,updated);if(identityChanged) showSelectedIdentity(selected);}}
        renderChats();if($('forward-dialog').open) renderForwardDestinations();if(selected && !sending) await loadMessages();$('sync-time').textContent=time(Date.now());
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
  $('connection-menu').addEventListener('click',()=>$('connection-dialog').showModal());
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
  $('message-text').addEventListener('input',()=>{editRevision++;pendingSend=null;});
  $('message-text').addEventListener('keydown',event=>{if(event.key==='Enter' && (event.ctrlKey || event.metaKey)) {event.preventDefault();$('composer').requestSubmit();}});
  $('attachment').addEventListener('change',()=>{
    const file=$('attachment').files[0];editRevision++;pendingSend=null;
    if(file?.size>10*1024*1024) {notice('Escolha um arquivo de até 10 MB.');$('attachment').value='';return;}
    attachment=file || null;$('attachment-name').textContent=file?file.name+' · '+(file.size/1024).toFixed(0)+' KB':'';$('attachment-info').hidden=!file;$('message-text').required=!attachment;
  });
  $('remove-attachment').addEventListener('click',()=>{editRevision++;attachment=null;pendingSend=null;$('attachment').value='';$('attachment-info').hidden=true;$('message-text').required=true;});
  const fileBase64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(file);});
  $('composer').addEventListener('submit',async event=>{
    event.preventDefault();if(!selected || sending || connection?.state!=='connected') return;
    const jid=selected.jid,text=$('message-text').value.trim(),file=attachment,submittedRevision=editRevision;if(!file && !text) return;
    sending=true;$('send').disabled=true;$('send-status').textContent='Enviando…';
    try {
      let submitted=pendingSend;
      if(!submitted) {
        const requestId=crypto.randomUUID();
        submitted=file?{route:'/send-media',input:{jid,caption:text,base64:await fileBase64(file),fileName:file.name,mimeType:file.type || 'application/octet-stream',mediaType:file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':'document',requestId}}:{route:'/send',input:{jid,text,requestId}};
        if(editRevision===submittedRevision) pendingSend=submitted;
      }
      await api(submitted.route,'POST',submitted.input);if(pendingSend===submitted) pendingSend=null;
      if(editRevision===submittedRevision) {$('message-text').value='';drafts.delete(jid);attachment=null;$('attachment').value='';$('attachment-info').hidden=true;$('message-text').required=true;}
      $('send-status').textContent='Mensagem aceita pelo conector. O status será atualizado no histórico.';
      await loadMessages();
    } catch(error) {$('send-status').textContent=error.message+' Confira a conversa antes de tentar outro envio.';}
    finally {sending=false;$('send').disabled=connection?.state!=='connected';}
  });
  $('new-chat').addEventListener('click',()=>{$('new-error').textContent='';$('new-dialog').showModal();});
  $('new-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {const chat=await api('/resolve-phone','POST',{phone:$('new-phone').value});$('new-dialog').close();await selectChat({...chat,status:'open',labels:[],unread:0});}catch(error) {$('new-error').textContent=error.message;}finally {button.disabled=false;}
  });
  function toggleContact(value) {detailsOpen=value;$('app-shell').classList.toggle('details-open',detailsOpen);$('show-contact').setAttribute('aria-expanded',String(detailsOpen || matchMedia('(min-width:1001px)').matches));}
  function showPanel(section) {
    for(const name of ['attendance','templates','connection']) {$('tab-'+name).classList.toggle('active',name===section);$('tab-'+name).setAttribute('aria-selected',String(name===section));$(name==='attendance'?'attendance-section':name+'-section').hidden=name!==section;}
  }
  const navIds=['nav-overview','nav-conversations','nav-pending','nav-closed','settings','nav-connection','nav-settings'];
  function setNavigation(id) {for(const name of navIds) {$(name).classList.toggle('active',name===id);if(name===id) $(name).setAttribute('aria-current','page');else $(name).removeAttribute('aria-current');}}
  function applyFilter(status='',unread=false,nav='nav-conversations') {$('search').value='';$('status-filter').value=status;$('unread-only').checked=unread;setNavigation(nav);renderChats();}
  $('nav-overview').addEventListener('click',()=>applyFilter('',false,'nav-overview'));
  $('nav-conversations').addEventListener('click',()=>{applyFilter();$('search').focus();});
  $('nav-pending').addEventListener('click',()=>applyFilter('pending',false,'nav-pending'));
  $('nav-closed').addEventListener('click',()=>applyFilter('closed',false,'nav-closed'));
  $('metric-total-button').addEventListener('click',()=>applyFilter('',false,'nav-overview'));
  $('metric-unread-button').addEventListener('click',()=>applyFilter('',true));
  $('metric-pending-button').addEventListener('click',()=>applyFilter('pending',false,'nav-pending'));
  $('metric-closed-button').addEventListener('click',()=>applyFilter('closed',false,'nav-closed'));
  $('filter-all').addEventListener('click',()=>applyFilter());$('filter-pending').addEventListener('click',()=>applyFilter('pending',false,'nav-pending'));
  $('toggle-filters').addEventListener('click',()=>{$('advanced-filters').hidden=!$('advanced-filters').hidden;$('toggle-filters').setAttribute('aria-expanded',String(!$('advanced-filters').hidden));});
  for(const section of ['attendance','templates','connection']) $('tab-'+section).addEventListener('click',()=>showPanel(section));
  $('nav-connection').addEventListener('click',()=>$('connection-dialog').showModal());
  $('manage-connection').addEventListener('click',()=>$('connection-dialog').showModal());
  $('nav-settings').addEventListener('click',()=>{setNavigation('nav-settings');showPanel('connection');toggleContact(true);});
  $('refresh-top').addEventListener('click',()=>{notice('');sync();});
  $('show-contact').addEventListener('click',()=>{showPanel('attendance');toggleContact(!detailsOpen);});$('hide-contact').addEventListener('click',()=>toggleContact(false));
  $('back-to-chats').addEventListener('click',()=>{if(sending) return;if(selected) drafts.set(selected.jid,$('message-text').value);selection++;selected=null;globalThis.WhatsAppFeatures?.onSelectChat?.(null);globalThis.WhatsAppSchedule?.onSelectChat?.(null);toggleContact(false);$('app-shell').classList.toggle('has-chat',false);$('contact-empty').hidden=false;$('contact-details').hidden=true;renderTemplateShortcuts();renderChats();});
  $('contact-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!selected) return;const jid=selected.jid,button=event.submitter;button.disabled=true;
    try {const detail=await api('/contact?jid='+encodeURIComponent(jid),'PATCH',{status:$('contact-status').value,labels:$('contact-labels').value.split(',').map(value=>value.trim()).filter(Boolean)});const chat=chats.find(item=>item.jid===jid);if(chat) Object.assign(chat,detail);renderChats();notice('Atendimento salvo.',true);}catch(error) {notice(error.message);}finally {button.disabled=false;}
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
    $('transcription-key-status').textContent=transcriptionSettings.aiConfigured?'Chave da OpenAI configurada.':'Nenhuma chave da OpenAI configurada.';
    $('remove-transcription-key').disabled=!transcriptionSettings.aiConfigured;
  }
  function loadTranscriptionSettings() {
    if(!transcriptionSettingsLoading) transcriptionSettingsLoading=api('/transcription/settings').then(settings=>{transcriptionSettings=settings;return settings;}).finally(()=>{transcriptionSettingsLoading=null;});
    return transcriptionSettingsLoading;
  }
  async function openTranscriptionSettings(reason='') {
    $('transcription-settings-status').textContent=reason;$('transcription-settings-error').textContent='';$('transcription-api-key').value='';
    if(!$('transcription-dialog').open) $('transcription-dialog').showModal();
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
      transcriptionSettings=await api('/transcription/settings','PATCH',{whisperModel:$('transcription-model').value,language:$('transcription-language').value,...(aiApiKey?{aiApiKey}:{})});
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
  globalThis.WhatsAppAvatars?.init?.({api});
  globalThis.WhatsAppFeatures?.init?.({api,notice,openChat:selectChat,getChats:()=>chats});
  globalThis.WhatsAppSchedule?.init?.({api,notice,getChats:()=>chats,getSelected:()=>selected,getDraft:()=>({text:$('message-text').value,hasAttachment:!!attachment,revision:editRevision}),onScheduled:(job,snapshot)=>{if(selected?.jid===job.jid && !attachment && editRevision===snapshot.revision && $('message-text').value===snapshot.text) {$('message-text').value='';drafts.delete(selected.jid);editRevision++;pendingSend=null;}}});
  (async()=>{try {templates=(await api('/settings')).templates;renderTemplates();}catch(error) {notice(error.message);}await sync();if(new URLSearchParams(location.search).has('conectar') && connection?.reachable && connection.state!=='connected') openQr();})();
  setInterval(sync,4000);
  setInterval(pollTranscriptions,2000);
})();
