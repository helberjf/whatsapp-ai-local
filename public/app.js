(() => {
  'use strict';
  const $=id=>document.getElementById(id),token=document.querySelector('meta[name="whatsapp-session"]')?.content;
  let connection=null,chats=[],selected=null,templates=[],messages=[],page=1,pages=1,selection=0,syncing=false,sending=false,qrTimer=null,qrBusy=false,attachment=null,pendingSend=null,editRevision=0,detailsOpen=false,historyLoaded=false;
  const drafts=new Map(),readIds=new Set(),mediaUrls=new Map(),audioViews=new Map(),videoViews=new Map(),deletedMessages=new Set(),messageCopyViews=new Map(),forwardRequestIds=new Map(),hooks={sync:[],view:[],select:[],open:[]};
  const runHooks=(name,...args)=>{for(const hook of hooks[name]) try {hook(...args);}catch {}};
  const transcriptionJobs=new Map(),transcriptionChoices=new Map(),transcriptionViews=new Map(),transcriptionErrors=new Map(),transcriptionRequests=new Set(),transcriptionLoads=new Set();
  let transcriptionSettings=null,transcriptionSettingsLoading=null;
  let historyQueue=Promise.resolve(),syncTask=Promise.resolve(),namesSyncing=false,forwardState=null,deleteState=null,attachmentKind=null,attachmentSelectionKind=null,activeMessageMenu=null;
  const statuses={open:'Em aberto',pending:'Pendente',closed:'Concluído'};
  const time=value=>value?new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'';
  const dateTime=value=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
  const initials=name=>String(name || '?').split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase();
  const phoneLabel=value=>{const digits=String(value || '').replace(/\D/g,'');return /^55\d{10,11}$/.test(digits)?digits.replace(/^55(\d{2})(\d{4,5})(\d{4})$/,'+55 $1 $2-$3'):digits?'+'+digits:'Nenhuma conta conectada';};
  function el(tag,className,text) {const node=document.createElement(tag);if(className) node.className=className;if(text!==undefined) node.textContent=text;return node;}
  async function api(route,method='GET',input,timeout=30000) {
    const response=await fetch('/api'+route,{method,headers:{'X-WhatsApp-Token':token,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(timeout)});
    const result=await response.json();if(!response.ok) throw new Error(result.error || 'Não foi possível completar a operação.');return result;
  }
  function notice(message,success=false) {$('notice').textContent=message;$('notice').classList.toggle('success',success);$('notice').hidden=!message;}
  function showConnection(value) {
    connection=value;const online=value.state==='connected';
    $('panel-connection-state').textContent=online?'Conectado':value.state==='connecting'?'Aguardando leitura do QR Code':value.reachable?'Pronto para conectar':'Conector indisponível';
    $('panel-connection-phone').textContent=online?phoneLabel(value.phone):'Nenhuma conta conectada';
    $('sync-label').textContent=online?'Atualização automática':'Aguardando conexão';
    $('status-whatsapp').textContent=online?'Conectado':value.state==='connecting'?'Aguardando QR':'Desconectado';$('dot-whatsapp').classList.toggle('on',online);
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
    $('filter-total-count').textContent=chats.length;$('nav-chat-count').textContent=chats.length;$('filter-unread-count').textContent=unreadCount;$('nav-pending-count').textContent=pendingCount;
    $('filter-all').classList.toggle('active',!status && !$('unread-only').checked);$('filter-pending').classList.toggle('active',status==='pending');
    $('filter-all').setAttribute('aria-pressed',String(!status && !$('unread-only').checked));$('filter-pending').setAttribute('aria-pressed',String(status==='pending'));
    const fragment=document.createDocumentFragment();
    for(const chat of filtered) {
      const button=el('button','chat-item'+(selected?.jid===chat.jid?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(selected?.jid===chat.jid));
      const avatar=el('span','avatar',initials(chat.name));globalThis.WhatsAppAvatars?.decorate?.(avatar,chat);button.append(avatar);
      const copy=el('span','chat-text'),title=el('span','chat-title');title.append(el('strong','',chat.name));
      if(['pending','closed'].includes(chat.status)) title.append(el('span','chat-status '+chat.status,statuses[chat.status]));
      if(chat.aiMode==='draft' || chat.aiMode==='auto') title.append(el('span','chat-status ai',chat.aiDraft && chat.lastMessage && !chat.lastMessage.fromMe?'IA: rascunho pronto':chat.aiMode==='auto'?'IA automática':'IA rascunho'));
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
    const label=el('div','media-card-label','Mensagem de voz'),wave=el('div','audio-wave');wave.setAttribute('aria-hidden','true');
    for(let index=0;index<32;index++) wave.append(el('i'));
    heading.append(load,clock,speed);card.append(label,heading,wave,player,status);return card;
  }
  function videoCard(message,jid) {
    const key=jid+'|'+message.id;if(videoViews.has(key)) return videoViews.get(key).card;
    const card=el('section','video-card'),label=el('div','media-card-label','Vídeo'),load=el('button','video-load','▶ Reproduzir vídeo'),player=el('video','video-player'),status=el('p','media-status');
    card.setAttribute('aria-label','Mensagem de vídeo');load.type='button';load.setAttribute('aria-label','Reproduzir vídeo');player.controls=true;player.preload='metadata';player.playsInline=true;player.hidden=true;player.setAttribute('aria-label','Player de vídeo');status.hidden=true;status.setAttribute('role','status');
    const view={card,player,loading:false};videoViews.set(key,view);
    load.addEventListener('click',async()=>{if(view.loading) return;const version=selection;view.loading=true;load.disabled=true;load.textContent='Carregando vídeo…';status.hidden=true;
      try {const media=await fetchMedia(message,jid);player.src=media.url;player.hidden=false;load.hidden=true;player.load?.();
        if(selected?.jid===jid && selection===version) {for(const other of document.querySelectorAll('audio,video')) if(other!==player && !other.paused) other.pause?.();
          try {await player.play?.();}catch(error) {status.textContent=error.name==='NotAllowedError'?'Vídeo carregado. Toque no ▶ do player para iniciar.':'Toque no ▶ do player para reproduzir. Se o formato não abrir, use Baixar vídeo.';status.hidden=false;}
        }
      }
      catch(error) {status.textContent=error.message;status.hidden=false;load.hidden=false;load.textContent='↻ Tentar carregar vídeo';}
      finally {view.loading=false;load.disabled=false;}
    });
    player.addEventListener('error',()=>{status.textContent='Este formato não pode ser reproduzido no navegador. Baixe o arquivo para abrir no seu computador.';status.hidden=false;load.hidden=false;load.textContent='↻ Carregar novamente';});
    const download=el('button','text-button media-download','↓ Baixar vídeo');download.type='button';download.addEventListener('click',()=>downloadMedia(message,jid,download));
    card.append(label,load,player,download,status);return card;
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
    const fragment=document.createDocumentFragment();transcriptionViews.clear();messageCopyViews.clear();
    for(const message of messages) {
      const row=el('article','message'+(message.fromMe?' mine':''));
      const removed=message.deleted || deletedMessages.has(selected.jid+'|'+message.id);
      if(removed) {row.className+=' message-deleted';row.append(el('p','','⊘ Mensagem apagada'));}
      else if(message.type==='audio') row.append(audioCard(message,selected.jid));
      else if(message.type==='video') row.append(videoCard(message,selected.jid));
      else if(message.type==='poll') {const poll=el('section','poll-card');poll.append(el('strong','',message.poll?.name || message.text || 'Enquete'));for(const choice of message.poll?.options || []) poll.append(el('div','poll-option','◯ '+choice));poll.append(el('small','muted','Para votar, abra esta conversa no WhatsApp.'));row.append(poll);}
      else if(message.type==='image' || (message.type==='document' && (message.mimeType==='application/pdf' || /\.pdf$/i.test(message.fileName || '')))) row.append(previewCard(message,selected.jid));
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
      if(message.text && !removed && message.type!=='poll') row.append(linkedText(message.text));
      if(message.type==='audio' && !removed) row.append(audioTranscription(message,selected.jid));
      const ack=!message.fromMe?'': ['READ','PLAYED',4,5].includes(message.status)?' · Lida':['DELIVERY_ACK','DELIVERED',3].includes(message.status)?' · Entregue':['ERROR','FAILED',0].includes(message.status)?' · Falha':['PENDING',1].includes(message.status)?' · Enviando':' · Enviada';
      if(!removed) row.append(messageActions(message,selected.jid));const meta=el('time','message-meta',time(message.timestamp)+ack);if(message.timestamp) meta.title=dateTime(message.timestamp);row.append(meta);fragment.append(row);
    }
    if(!messages.length) fragment.append(el('p','muted','Ainda não há mensagens sincronizadas nesta conversa.'));
    closeMessageMenu();container.replaceChildren(fragment);$('older').hidden=page>=pages;$('history-info').textContent=messages.length?`${messages.length} mensagens carregadas`:'';
    if(keepScroll) container.scrollTop=oldTop+container.scrollHeight-oldHeight;
    else if(nearBottom || forceBottom) container.scrollTop=container.scrollHeight;
  }
  async function fetchMedia(message,jid) {
      const key=jid+'|'+message.id;if(mediaUrls.has(key)) return mediaUrls.get(key);
      const result=await api(`/media?jid=${encodeURIComponent(jid)}&id=${encodeURIComponent(message.id)}`,'GET',undefined,100000);
      const raw=result.base64.replace(/^data:[^,]*,/,'');if(!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) throw new Error('Mídia retornada em formato inválido.');
      const bytes=Uint8Array.from(atob(raw),char=>char.charCodeAt(0));
      const previewMime=globalThis.WhatsAppMedia?.previewMime?.(bytes) || null,mimeType=previewMime || result.mimeType,url=URL.createObjectURL(new Blob([bytes],{type:mimeType}));
      const media={url,mimeType,previewMime,bytes,fileName:result.fileName || message.fileName || 'anexo'};mediaUrls.set(key,media);return media;
  }
  function previewCard(message,jid) {
    const card=el('section','attachment-card'),pdf=message.type==='document',button=el('button','attachment-preview-button',pdf?'Abrir PDF':'Abrir imagem'),label=el('span','attachment-caption',message.fileName || (pdf?'Documento PDF':'Imagem da conversa'));
    button.type='button';button.setAttribute('aria-label',pdf?'Abrir PDF':'Abrir imagem');
    const cached=mediaUrls.get(jid+'|'+message.id);if(cached && !pdf && /^image\/(png|jpeg|gif|webp|avif)$/.test(cached.mimeType)) {button.textContent='';const image=el('img');image.src=cached.url;image.alt=message.text || 'Imagem da conversa';button.append(image);}
    button.addEventListener('click',async()=>{button.disabled=true;const version=selection;
      try {const media=await fetchMedia(message,jid);if(selected?.jid!==jid || selection!==version) return;await globalThis.WhatsAppMedia?.open?.(media,pdf?'pdf':'image');}
      catch(error) {notice(error.message);}finally {button.disabled=false;}
    });card.append(button,label);const download=el('button','text-button attachment-download','Baixar');download.type='button';download.addEventListener('click',()=>downloadMedia(message,jid,download));card.append(download);return card;
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
    const unread=result.messages.filter(message=>!message.fromMe && message.key?.fromMe===false && message.key.remoteJid===jid && !readIds.has(jid+'|'+message.id));
    if(unread.length && document.visibilityState==='visible') {
      await api('/read','POST',{jid,keys:unread.map(message=>message.key)});
      if(selected?.jid===jid) {unread.forEach(message=>readIds.add(jid+'|'+message.id));const chat=chats.find(item=>item.jid===jid);if(chat) chat.unread=0;renderChats();}
    }
  }
  async function loadContact(jid=selected?.jid) {
    if(!jid) return;const version=selection,detail=await api('/contact?jid='+encodeURIComponent(jid));if(selected?.jid!==jid || version!==selection) return;
    $('contact-status').value=detail.status;$('contact-ai').value=detail.aiMode || 'off';$('contact-labels').value=detail.labels.join(', ');
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
    selected=chat;selection++;editRevision++;historyQueue=Promise.resolve();historyLoaded=false;messages=[];page=1;pages=1;attachment=null;attachmentKind=null;pendingSend=null;$('attachment').value='';$('attachment-info').hidden=true;$('message-text').required=true;$('send-status').textContent='';
    globalThis.WhatsAppMedia?.onAttachment?.(null);
    $('conversation-empty').hidden=true;$('conversation-content').hidden=false;$('contact-empty').hidden=true;$('contact-details').hidden=false;
    $('app-shell').classList.toggle('has-chat',true);
    showSelectedIdentity(chat);$('message-text').value=drafts.get(chat.jid) || '';renderTemplateShortcuts();
    globalThis.WhatsAppFeatures?.onSelectChat?.(chat);
    globalThis.WhatsAppSchedule?.onSelectChat?.(chat);
    renderChats();renderMessages();$('messages').replaceChildren(el('p','muted','Carregando histórico…'));
    $('contact-status').value=chat.status || 'open';$('contact-ai').value=chat.aiMode || 'off';$('contact-labels').value=(chat.labels || []).join(', ');$('notes').replaceChildren();
    try {await Promise.all([loadMessages(),loadContact(chat.jid),loadTranscriptions(chat.jid)]);runHooks('open',chat);}catch(error) {notice(error.message);}
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
    if(syncing) return force?syncTask.then(()=>sync()):syncTask;syncing=true;
    syncTask=(async()=>{
    try {
      const value=await api('/connection');showConnection(value);
      if(value.state==='connected') {
        chats=await api('/chats');globalThis.WhatsAppFeatures?.onChats?.(chats);globalThis.WhatsAppSchedule?.onChats?.(chats);
        if(selected) {const updated=chats.find(chat=>chat.jid===selected.jid);if(updated) {const identityChanged=selected.name!==updated.name || contactPhone(selected)!==contactPhone(updated);Object.assign(selected,updated);if(identityChanged) showSelectedIdentity(selected);}}
        renderChats();runHooks('sync');if($('forward-dialog').open) renderForwardDestinations();if(selected && !sending) await loadMessages();$('sync-time').textContent=time(Date.now());
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
  $('message-text').addEventListener('input',()=>{editRevision++;pendingSend=null;});
  $('message-text').addEventListener('keydown',event=>{if(event.key==='Enter' && !event.shiftKey && !event.altKey && !event.isComposing && event.keyCode!==229 && !event.repeat) {event.preventDefault();$('composer').requestSubmit();}});
  function setAttachment(file,kind=null) {
    editRevision++;pendingSend=null;
    if(file?.size>10*1024*1024) {notice('Escolha um arquivo de até 10 MB.');$('attachment').value='';return;}
    attachment=file || null;attachmentKind=kind;$('attachment-name').textContent=file?(kind==='sticker'?'Figurinha · ':'')+file.name+' · '+(file.size/1024).toFixed(0)+' KB':'';$('attachment-info').hidden=!file;$('message-text').required=!attachment;if(file) $('message-text').focus();
    globalThis.WhatsAppMedia?.onAttachment?.(attachment);
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
  $('composer').addEventListener('submit',async event=>{
    event.preventDefault();if(!selected || sending || connection?.state!=='connected') return;
    if(globalThis.WhatsAppMedia?.isRecording?.()) {notice('Pare a gravação para ouvir e enviar o áudio.');return;}
    const jid=selected.jid,text=$('message-text').value.trim(),file=attachment,kind=attachmentKind,submittedRevision=editRevision;if(!file && !text) return;
    sending=true;$('send').disabled=true;$('send-status').textContent='Enviando…';
    try {
      let submitted=pendingSend;
      if(!submitted) {
        const requestId=crypto.randomUUID();
        if(file && kind==='sticker' && text) throw new Error('Figurinhas não têm legenda. Remova o texto ou envie-o separadamente.');
        submitted=file?{route:kind==='sticker'?'/send-sticker':'/send-media',input:{jid,caption:text,base64:await fileBase64(file),fileName:file.name,mimeType:file.type || 'application/octet-stream',mediaType:kind==='document'?'document':file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':'document',requestId}}:{route:'/send',input:{jid,text,requestId}};
        if(editRevision===submittedRevision) pendingSend=submitted;
      }
      await api(submitted.route,'POST',submitted.input);if(pendingSend===submitted) pendingSend=null;
      if(editRevision===submittedRevision) {$('message-text').value='';drafts.delete(jid);attachment=null;attachmentKind=null;$('attachment').value='';$('attachment-info').hidden=true;$('message-text').required=true;globalThis.WhatsAppMedia?.onAttachment?.(null);}
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
  function toggleContact(value) {detailsOpen=value;$('app-shell').classList.toggle('details-open',detailsOpen);$('show-contact').setAttribute('aria-expanded',String(detailsOpen));}
  function showPanel(section) {
    for(const name of ['attendance','products','assistant','templates','connection']) {$('tab-'+name).classList.toggle('active',name===section);$('tab-'+name).setAttribute('aria-selected',String(name===section));$(name==='attendance'?'attendance-section':name+'-section').hidden=name!==section;}
  }
  const navIds=['nav-overview','nav-conversations','nav-contacts','nav-pending','nav-closed','nav-knowledge','nav-products','nav-ai','settings','nav-connection','nav-settings'];
  const pageIds=['page-contacts','page-knowledge','page-products','page-ai'];
  function showView(view='workspace',nav) {
    const workspace=view==='workspace';$('metrics').hidden=!workspace;$('workspace').hidden=!workspace;
    for(const id of pageIds) $(id).hidden=id!==view;
    if(nav) setNavigation(nav);
    runHooks('view',view);
  }
  function openChat(chat) {showView('workspace','nav-conversations');return selectChat(chat);}
  function setNavigation(id) {for(const name of navIds) {$(name).classList.toggle('active',name===id);if(name===id) $(name).setAttribute('aria-current','page');else $(name).removeAttribute('aria-current');}}
  function applyFilter(status='',unread=false,nav='nav-conversations') {showView('workspace');$('search').value='';$('status-filter').value=status;$('unread-only').checked=unread;setNavigation(nav);renderChats();}
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
  for(const section of ['attendance','products','assistant','templates','connection']) $('tab-'+section).addEventListener('click',()=>showPanel(section));
  $('nav-connection').addEventListener('click',()=>$('connection-dialog').showModal());
  $('manage-connection').addEventListener('click',()=>$('connection-dialog').showModal());
  $('nav-settings').addEventListener('click',()=>{showView('workspace','nav-settings');showPanel('connection');toggleContact(true);});
  $('refresh-top').addEventListener('click',()=>{notice('');sync();});
  $('show-contact').addEventListener('click',()=>{showPanel('attendance');toggleContact(!detailsOpen);});$('hide-contact').addEventListener('click',()=>toggleContact(false));
  $('back-to-chats').addEventListener('click',()=>{if(sending) return;if(selected) drafts.set(selected.jid,$('message-text').value);selection++;selected=null;globalThis.WhatsAppFeatures?.onSelectChat?.(null);globalThis.WhatsAppSchedule?.onSelectChat?.(null);toggleContact(false);$('app-shell').classList.toggle('has-chat',false);$('contact-empty').hidden=false;$('contact-details').hidden=true;renderTemplateShortcuts();renderChats();});
  $('contact-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!selected) return;const jid=selected.jid,button=event.submitter;button.disabled=true;
    try {const detail=await api('/contact?jid='+encodeURIComponent(jid),'PATCH',{status:$('contact-status').value,aiMode:$('contact-ai').value || undefined,labels:$('contact-labels').value.split(',').map(value=>value.trim()).filter(Boolean)});const chat=chats.find(item=>item.jid===jid);if(chat) Object.assign(chat,detail);renderChats();notice('Atendimento salvo.',true);}catch(error) {notice(error.message);}finally {button.disabled=false;}
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
  globalThis.WhatsAppTriggers?.init?.({api,notice,getChats:()=>chats,getSelected:()=>selected});
  globalThis.WhatsAppMedia?.init?.({notice,setAttachment,getSelected:()=>selected,canRecord:()=>!!selected && !sending && !attachment && connection?.state==='connected',hooks});
  const mainNav=document.querySelector('.main-nav');
  if(mainNav?.append) for(const id of ['nav-overview','nav-conversations','nav-contacts','nav-crm','nav-products','nav-knowledge','nav-ai','nav-triggers','nav-automation','nav-schedule','settings','transcription-settings','nav-connection','nav-settings','nav-pending','nav-closed']) {const entry=$(id);if(entry) {entry.setAttribute('aria-label',entry.getAttribute('aria-label') || entry.textContent.trim());mainNav.append(entry);}}
  hooks.sync.push(()=>globalThis.WhatsAppTriggers?.onChats?.(chats));hooks.select.push(()=>globalThis.WhatsAppTriggers?.onSelectChat?.(selected));
  (async()=>{try {templates=(await api('/settings')).templates;renderTemplates();}catch(error) {notice(error.message);}await sync();if(new URLSearchParams(location.search).has('conectar') && connection?.reachable && connection.state!=='connected') openQr();})();
  setInterval(sync,4000);
  setInterval(pollTranscriptions,2000);
  // Ponte para pages.js (base de conhecimento, produtos, IA e CRM).
  globalThis.WhatsAppCentral={$,el,api,notice,time,dateTime,initials,phoneLabel,showView,insertDraft,openChat,hooks,chats:()=>chats,selected:()=>selected,connection:()=>connection,contextSnapshot:()=>({jid:selected?.jid || null,selection,revision:editRevision,lastMessageId:messages.at(-1)?.id || null,lastTextId:messages.filter(message=>message.type==='text'&&!message.deleted&&message.canForward!==false&&message.text?.trim()).at(-1)?.id || null})};
})();
