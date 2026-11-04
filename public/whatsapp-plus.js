(() => {
  'use strict';
  // Recursos do WhatsApp na central: responder, reagir, editar, favoritar, ouvir, localização, contato,
  // fixar, silenciar, arquivar, não lida, bloquear, busca na conversa, notificações, perfil e privacidade.
  const C=globalThis.WhatsAppCentral;if(!C) return;
  const {$,el,api,notice}=C;
  const QUICK_REACTIONS=['👍','❤️','😂','😮','😢','🙏'];
  const PRIVACY_LABELS={all:'Todos',contacts:'Meus contatos',contact_blacklist:'Meus contatos, exceto…',none:'Ninguém'};
  const NO_REPLY='Sem resposta';
  let reply=null,showArchived=false,showUnanswered=false,starred=new Map(),editState=null,searchState={query:'',hits:[],index:-1};
  let typing={jid:null,at:0},recordingTimer=null,shareTyping=true,notifiedAt=new Map(),notificationsReady=false;
  const pending=new Map(),requestIds=new Map();
  const store=(()=>{try {return globalThis.localStorage;}catch {return null;}})();
  const pref=(key,fallback)=>{try {const value=store?.getItem('whats-ai:'+key);return value===null || value===undefined?fallback:value==='1';}catch {return fallback;}};
  const setPref=(key,value)=>{try {store?.setItem('whats-ai:'+key,value?'1':'0');}catch {}};
  const prefs={notifications:pref('notifications',false),sound:pref('sound',false)};
  const normalize=text=>String(text || '').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
  const selected=()=>C.selected();
  const chatOf=jid=>C.chats().find(chat=>chat.jid===jid);
  const muted=chat=>chat?.mutedUntil==='always' || (Number.isFinite(Date.parse(chat?.mutedUntil || '')) && Date.parse(chat.mutedUntil)>Date.now());
  function icon(name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');
    svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#i-'+name);svg.append(use);return svg;
  }
  function stableRequest(key) {if(!requestIds.has(key)) requestIds.set(key,crypto.randomUUID());return requestIds.get(key);}

  // ---------- Lista de conversas: fixadas no topo, arquivadas à parte, ícones de estado ----------
  function arrangeChats(list) {
    const searching=Boolean($('search')?.value.trim()),waiting=chat=>Array.isArray(chat.labels) && chat.labels.includes(NO_REPLY);
    const archivedCount=C.chats().filter(chat=>chat.archived===true).length,unansweredCount=C.chats().filter(waiting).length;
    $('filter-archived').hidden=!archivedCount && !showArchived;$('filter-archived-count').textContent=archivedCount;
    $('filter-unanswered').hidden=!unansweredCount && !showUnanswered;$('filter-unanswered-count').textContent=unansweredCount;
    // Filtros da equipe (Aguardando, Minhas) têm precedência quando ativos.
    const teamView=globalThis.WhatsAppTeam?.filter?.(list.filter(chat=>chat.archived!==true));if(teamView) return teamView;
    // "Sem resposta" é a fila do atendente: quem espera há mais tempo aparece primeiro.
    if(showUnanswered) return list.filter(waiting).sort((a,b)=>Number(a.lastMessage?.timestamp || 0)-Number(b.lastMessage?.timestamp || 0));
    const visible=searching?list:list.filter(chat=>showArchived?chat.archived===true:chat.archived!==true);
    if(showArchived || searching) return visible;
    const pinned=visible.filter(chat=>chat.pinned===true).sort((a,b)=>String(b.pinnedAt || '').localeCompare(String(a.pinnedAt || '')));
    return [...pinned,...visible.filter(chat=>chat.pinned!==true)];
  }
  function decorateChat(button,chat,title) {
    globalThis.WhatsAppTeam?.decorate?.(button,chat,title);
    const flags=[];
    if(chat.pinned) flags.push(['pin','Conversa fixada']);
    if(muted(chat)) flags.push(['mute','Notificações silenciadas']);
    if(chat.archived) flags.push(['archive','Conversa arquivada']);
    if(chat.blocked) flags.push(['block','Contato bloqueado']);
    if(!flags.length) return;
    const box=el('span','chat-flags');
    for(const [name,label] of flags) {const item=el('span','chat-flag '+name);item.title=label;item.setAttribute('aria-label',label);item.append(icon(name));box.append(item);}
    title.append(box);if(chat.pinned) button.classList.add('pinned');
  }
  function resetFilters() {
    showArchived=false;showUnanswered=false;
    for(const id of ['filter-archived','filter-unanswered']) {$(id).classList.remove('active');$(id).setAttribute('aria-pressed','false');}
  }
  $('filter-unanswered').addEventListener('click',()=>{
    globalThis.WhatsAppTeam?.resetFilter?.();
    showUnanswered=!showUnanswered;if(showUnanswered && showArchived) {showArchived=false;$('filter-archived').classList.remove('active');$('filter-archived').setAttribute('aria-pressed','false');}
    $('filter-unanswered').classList.toggle('active',showUnanswered);$('filter-unanswered').setAttribute('aria-pressed',String(showUnanswered));
    $('inbox-title').firstChild.textContent=showUnanswered?'Sem resposta ':'Conversas ';C.renderChats();
  });
  $('filter-archived').addEventListener('click',()=>{
    globalThis.WhatsAppTeam?.resetFilter?.();
    if(showUnanswered) {showUnanswered=false;$('filter-unanswered').classList.remove('active');$('filter-unanswered').setAttribute('aria-pressed','false');}
    showArchived=!showArchived;$('filter-archived').classList.toggle('active',showArchived);$('filter-archived').setAttribute('aria-pressed',String(showArchived));
    $('inbox-title').firstChild.textContent=showArchived?'Arquivadas ':'Conversas ';C.renderChats();
  });
  for(const id of ['filter-all','filter-pending','nav-conversations','nav-overview']) $(id)?.addEventListener('click',()=>{globalThis.WhatsAppTeam?.resetFilter?.();if(showUnanswered) {showUnanswered=false;$('filter-unanswered').classList.remove('active');$('filter-unanswered').setAttribute('aria-pressed','false');$('inbox-title').firstChild.textContent='Conversas ';C.renderChats();}if(!showArchived) return;showArchived=false;$('filter-archived').classList.remove('active');$('filter-archived').setAttribute('aria-pressed','false');$('inbox-title').firstChild.textContent='Conversas ';C.renderChats();});

  // ---------- Ações em cada mensagem ----------
  function pendingReactions(jid) {
    const list=(pending.get(jid) || []).filter(item=>Date.now()-item.timestamp<120_000);pending.set(jid,list);return list;
  }
  function myReaction(jid,id) {
    const local=pendingReactions(jid).filter(item=>item.targetId===id).at(-1);if(local) return local.emoji;
    return C.messages().filter(item=>item.type==='reaction' && item.fromMe && item.reaction?.targetId===id).sort((a,b)=>a.timestamp-b.timestamp).at(-1)?.reaction?.emoji || '';
  }
  async function react(jid,message,emoji) {
    const current=myReaction(jid,message.id),next=current===emoji?'':emoji;
    try {
      await api('/messages/react','POST',{jid,messageId:message.id,emoji:next,requestId:crypto.randomUUID()});
      pending.set(jid,[...pendingReactions(jid).filter(item=>item.targetId!==message.id),{targetId:message.id,emoji:next,timestamp:Date.now()}]);
      if(selected()?.jid===jid) C.renderMessages();
    } catch(error) {notice(error.message);}
  }
  function setReply(jid,message) {
    const chat=chatOf(jid) || selected();
    reply={jid,id:message.id,author:message.fromMe?'Você':chat?.name || 'Contato',text:C.previewText(message) || 'Mensagem'};
    $('reply-author').textContent=reply.author;$('reply-text').textContent=reply.text;$('reply-bar').hidden=false;C.touchDraft();$('message-text').focus();
  }
  function clearReply() {if(!reply) return;reply=null;$('reply-bar').hidden=true;C.touchDraft();}
  $('reply-cancel').addEventListener('click',clearReply);
  function speakAloud(text) {
    if(!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {notice('Este navegador não lê textos em voz alta.');return;}
    speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='pt-BR';
    const voice=speechSynthesis.getVoices().find(item=>item.lang==='pt-BR') || speechSynthesis.getVoices().find(item=>item.lang?.startsWith('pt'));if(voice) utterance.voice=voice;
    speechSynthesis.speak(utterance);
  }
  function extendActions({options,message,jid,close}) {
    if(message.deleted || message.type==='reaction') return;
    const button=(label,className,action)=>{const node=el('button',className,label);node.type='button';node.addEventListener('click',()=>{close();action();});return node;};
    const bar=el('div','reaction-bar');bar.setAttribute('role','group');bar.setAttribute('aria-label','Reagir');
    const mine=myReaction(jid,message.id);
    for(const emoji of QUICK_REACTIONS) {const node=button(emoji,'reaction-choice'+(mine===emoji?' active':''),()=>react(jid,message,emoji));node.setAttribute('aria-label',(mine===emoji?'Remover reação ':'Reagir com ')+emoji);node.setAttribute('aria-pressed',String(mine===emoji));bar.append(node);}
    options.insertBefore(bar,options.firstChild);
    const items=[button('Responder','message-reply',()=>setReply(jid,message))];
    if(message.canEdit && message.fromMe && (!message.timestamp || Date.now()-message.timestamp<15*60_000)) items.push(button('Editar','message-edit',()=>openEdit(jid,message)));
    const isStar=starred.has(jid+'|'+message.id);
    items.push(button(isStar?'Remover das favoritas':'Favoritar','message-star',()=>toggleStar(jid,message,!isStar)));
    const text=message.text || '';if(text && ['text','image','video','document'].includes(message.type)) items.push(button('Ouvir em voz alta','message-speak',()=>speakAloud(text)));
    const anchor=bar.nextSibling;for(const item of items) options.insertBefore(item,anchor);
  }
  function openEdit(jid,message) {
    editState={jid,messageId:message.id,requestId:crypto.randomUUID(),busy:false};
    $('edit-text').value=message.text || '';$('edit-error').textContent='';$('edit-save').disabled=false;$('edit-dialog').showModal();$('edit-text').focus();
  }
  $('edit-form').addEventListener('submit',async event=>{
    event.preventDefault();const state=editState;if(!state || state.busy) return;const text=$('edit-text').value.trim();if(!text) return;
    state.busy=true;$('edit-save').disabled=true;$('edit-error').textContent='';
    try {
      await api('/messages/edit','POST',{jid:state.jid,messageId:state.messageId,text,requestId:state.requestId});
      const local=C.messages().find(item=>item.id===state.messageId);if(local) Object.assign(local,{text,edited:true});
      if(editState===state) {$('edit-dialog').close();editState=null;}if(selected()?.jid===state.jid) C.renderMessages();notice('Mensagem editada.',true);
    } catch(error) {if(editState===state) $('edit-error').textContent=error.message;}
    finally {state.busy=false;if(editState===state) $('edit-save').disabled=false;}
  });

  // ---------- Favoritas ----------
  async function loadStarred() {try {starred=new Map((await api('/starred')).map(entry=>[entry.jid+'|'+entry.messageId,entry]));}catch {}}
  async function toggleStar(jid,message,value) {
    try {
      const entry=await api('/starred','PUT',{jid,messageId:message.id,starred:value});
      if(value) starred.set(jid+'|'+message.id,entry);else starred.delete(jid+'|'+message.id);
      if(selected()?.jid===jid) C.renderMessages();notice(value?'Mensagem favoritada.':'Mensagem removida das favoritas.',true);
    } catch(error) {notice(error.message);}
  }
  let starredScope=null;
  function renderStarred() {
    const query=normalize($('starred-search').value),fragment=document.createDocumentFragment();
    const rows=[...starred.values()].filter(entry=>(!starredScope || entry.jid===starredScope) && (!query || normalize(entry.text+' '+(chatOf(entry.jid)?.name || '')).includes(query))).sort((a,b)=>b.at-a.at);
    for(const entry of rows) {
      const chat=chatOf(entry.jid),item=el('article','starred-item'),head=el('div','starred-head');
      head.append(el('strong','',entry.fromMe?'Você → '+(chat?.name || 'contato'):(chat?.name || 'Contato')),el('time','',entry.timestamp?C.dateTime(entry.timestamp):''));
      const open=el('button','text-button','Abrir conversa'),remove=el('button','text-button','Remover');open.type='button';remove.type='button';
      open.addEventListener('click',async()=>{if(!chat) {notice('Esta conversa não está na lista atual.');return;}$('starred-dialog').close();await C.openChat(chat);setTimeout(()=>focusMessage(entry.messageId),300);});
      remove.addEventListener('click',async()=>{await toggleStar(entry.jid,{id:entry.messageId},false);renderStarred();});
      const actions=el('div','starred-actions');actions.append(open,remove);
      item.append(head,el('p','',entry.text || ({audio:'🎤 Áudio',image:'Imagem',video:'Vídeo',document:'Documento',sticker:'Figurinha',location:'📍 Localização',contact:'👤 Contato'}[entry.type] || 'Mensagem')),actions);fragment.append(item);
    }
    if(!rows.length) fragment.append(el('p','muted','Nenhuma mensagem favorita'+(starredScope?' nesta conversa':'')+'. Use ⌄ → Favoritar em uma mensagem.'));
    $('starred-list').replaceChildren(fragment);
  }
  async function openStarred(scope=null) {starredScope=scope;$('starred-search').value='';$('starred-title').textContent=scope?'Favoritas desta conversa':'Mensagens favoritas';await loadStarred();renderStarred();$('starred-dialog').showModal();}
  $('starred-search').addEventListener('input',renderStarred);
  $('nav-starred').addEventListener('click',()=>openStarred());

  // ---------- Busca dentro da conversa ----------
  function focusMessage(id) {
    const row=C.messageRow(id);if(!row) {notice('A mensagem não está carregada. Use "Carregar mensagens anteriores".');return false;}
    row.scrollIntoView({block:'center',behavior:'smooth'});row.classList.add('message-highlight');setTimeout(()=>row.classList.remove('message-highlight'),1600);return true;
  }
  function runSearch(move=0) {
    const query=normalize($('chat-search').value.trim());
    for(const id of searchState.hits) C.messageRow(id)?.classList.remove('search-hit');
    if(!query) {searchState={query:'',hits:[],index:-1};$('chat-search-count').textContent='';return;}
    const hits=C.messages().filter(message=>message.type!=='reaction' && !message.deleted && normalize(message.text).includes(query)).map(message=>message.id);
    let index=searchState.query===query && hits.length?searchState.index:hits.length-1;
    if(move && hits.length) index=(index+move+hits.length)%hits.length;
    searchState={query,hits,index};for(const id of hits) C.messageRow(id)?.classList.add('search-hit');
    $('chat-search-count').textContent=hits.length?`${index+1} de ${hits.length}`:'Nenhum resultado nas mensagens carregadas';
    if(hits.length && (move || searchState.index===index)) focusMessage(hits[index]);
  }
  function toggleSearch(open) {
    $('chat-search-bar').hidden=!open;$('chat-search-toggle').setAttribute('aria-expanded',String(open));
    if(open) {$('chat-search').focus();runSearch();}else {$('chat-search').value='';runSearch();}
  }
  $('chat-search-toggle').addEventListener('click',()=>toggleSearch($('chat-search-bar').hidden));
  $('chat-search-close').addEventListener('click',()=>toggleSearch(false));
  $('chat-search').addEventListener('input',()=>runSearch());
  $('chat-search').addEventListener('keydown',event=>{if(event.key==='Enter') {event.preventDefault();runSearch(event.shiftKey?-1:1);}if(event.key==='Escape') toggleSearch(false);});
  $('chat-search-prev').addEventListener('click',()=>runSearch(-1));$('chat-search-next').addEventListener('click',()=>runSearch(1));

  // ---------- Ações da conversa (painel do contato) ----------
  function renderChatActions() {
    const chat=selected()?chatOf(selected().jid) || selected():null;if(!chat) return;
    const label=(id,text)=>{$(id).querySelector('span').textContent=text;};
    label('chat-pin',chat.pinned?'Desafixar conversa':'Fixar conversa');label('chat-mute',muted(chat)?'Reativar notificações':'Silenciar');
    label('chat-archive',chat.archived?'Desarquivar':'Arquivar');label('chat-block',chat.blocked?'Desbloquear contato':'Bloquear contato');
    $('chat-unread').disabled=chat.markedUnread===true;
    const flags=$('contact-flags');flags.replaceChildren();
    for(const [on,text] of [[chat.blocked,'Bloqueado'],[muted(chat),'Silenciada'],[chat.archived,'Arquivada'],[chat.pinned,'Fixada']]) if(on) flags.append(el('span','pill small',text));
  }
  async function updateState(input,success) {
    const chat=selected();if(!chat) return;const jid=chat.jid;
    $('chat-actions-status').textContent='Aplicando…';
    try {
      const state=await api('/chat-state?jid='+encodeURIComponent(jid),'PATCH',input);
      for(const target of [chatOf(jid),selected()?.jid===jid?selected():null]) if(target) Object.assign(target,state);
      C.renderChats();if(selected()?.jid===jid) renderChatActions();$('chat-actions-status').textContent='';notice(success,true);
    } catch(error) {$('chat-actions-status').textContent=error.message;}
  }
  $('chat-pin').addEventListener('click',()=>{const chat=chatOf(selected()?.jid) || selected();updateState({pinned:!chat?.pinned},chat?.pinned?'Conversa desafixada.':'Conversa fixada no topo.');});
  $('chat-mute').addEventListener('click',()=>{const chat=chatOf(selected()?.jid) || selected();if(muted(chat)) updateState({muteHours:0},'Notificações reativadas.');else $('mute-dialog').showModal();});
  for(const option of document.querySelectorAll('[data-mute]')) option.addEventListener('click',()=>{const hours=Number(option.dataset.mute);$('mute-dialog').close();updateState({muteHours:hours},hours===0?'Notificações reativadas.':'Conversa silenciada.');});
  $('chat-archive').addEventListener('click',()=>{const chat=chatOf(selected()?.jid) || selected();updateState({archived:!chat?.archived},chat?.archived?'Conversa desarquivada.':'Conversa arquivada. Veja em “Arquivadas”.');});
  $('chat-unread').addEventListener('click',()=>updateState({markedUnread:true},'Conversa marcada como não lida.'));
  $('chat-starred').addEventListener('click',()=>{if(selected()) openStarred(selected().jid);});
  $('chat-block').addEventListener('click',()=>{
    const chat=chatOf(selected()?.jid) || selected();if(!chat) return;
    if(!chat.blocked && !confirm(`Bloquear ${chat.name}? Contatos bloqueados não podem ligar nem enviar mensagens para você.`)) return;
    updateState({blocked:!chat.blocked},chat.blocked?'Contato desbloqueado.':'Contato bloqueado.');
  });

  // ---------- Localização e contato ----------
  function openFromAttachments(id) {$('attachment-dialog').close();if(!selected()) {notice('Abra uma conversa primeiro.');return;}$(id).showModal();}
  $('attach-location').addEventListener('click',()=>{$('location-error').textContent='';openFromAttachments('location-dialog');});
  $('location-current').addEventListener('click',()=>{
    if(!navigator.geolocation) {$('location-error').textContent='Este navegador não informa a localização.';return;}
    $('location-current').disabled=true;$('location-error').textContent='Obtendo localização…';
    navigator.geolocation.getCurrentPosition(position=>{$('location-lat').value=position.coords.latitude.toFixed(6);$('location-lng').value=position.coords.longitude.toFixed(6);$('location-error').textContent='Localização preenchida. Revise antes de enviar.';$('location-current').disabled=false;},
      error=>{$('location-error').textContent=error.code===1?'Permita o acesso à localização neste navegador ou digite as coordenadas.':'Não foi possível obter a localização. Digite as coordenadas.';$('location-current').disabled=false;},{enableHighAccuracy:true,timeout:15000});
  });
  async function sendExtra(route,input,dialog,errorId,success) {
    const chat=selected();if(!chat) return;const jid=chat.jid,key=route+'|'+jid+'|'+JSON.stringify(input),quotedId=reply?.jid===jid?reply.id:undefined;
    try {
      await api(route,'POST',{jid,...input,...(quotedId?{quotedId}:{}),requestId:stableRequest(key)});requestIds.delete(key);
      $(dialog).close();if(reply?.jid===jid) clearReply();notice(success,true);await C.loadMessages();
    } catch(error) {$(errorId).textContent=error.message;}
  }
  $('location-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;if(button) button.disabled=true;$('location-error').textContent='';
    const number=value=>Number(String(value).trim().replace(',','.'));
    try {await sendExtra('/send-location',{latitude:number($('location-lat').value),longitude:number($('location-lng').value),name:$('location-name').value.trim() || undefined,address:$('location-address').value.trim() || undefined},'location-dialog','location-error','Localização enviada.');}
    finally {if(button) button.disabled=false;}
  });
  $('attach-contact').addEventListener('click',()=>{
    const pick=$('contact-share-pick');pick.replaceChildren(el('option','','Digitar manualmente…'));pick.firstElementChild.value='';
    for(const chat of C.chats().filter(chat=>chat.phone).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'))) {const option=el('option','',chat.name+' · '+C.phoneLabel(chat.phone));option.value=chat.jid;pick.append(option);}
    for(const id of ['contact-share-name','contact-share-phone','contact-share-org']) $(id).value='';$('contact-share-error').textContent='';openFromAttachments('contact-share-dialog');
  });
  $('contact-share-pick').addEventListener('change',()=>{const chat=chatOf($('contact-share-pick').value);if(!chat) return;$('contact-share-name').value=chat.nameSource==='number'?'':chat.name;$('contact-share-phone').value='+'+chat.phone;});
  $('contact-share-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;if(button) button.disabled=true;$('contact-share-error').textContent='';
    try {await sendExtra('/send-contact',{fullName:$('contact-share-name').value.trim(),phone:$('contact-share-phone').value.trim(),organization:$('contact-share-org').value.trim() || undefined},'contact-share-dialog','contact-share-error','Contato enviado.');}
    finally {if(button) button.disabled=false;}
  });

  // ---------- "Digitando…" e "gravando áudio…" para o contato ----------
  function onTyping(jid) {
    if(!shareTyping || !jid || (typing.jid===jid && Date.now()-typing.at<3500)) return;
    typing={jid,at:Date.now()};api('/presence','POST',{jid,presence:'composing'},15000).catch(()=>{});
  }
  function onRecording(jid,active) {
    clearInterval(recordingTimer);recordingTimer=null;if(!shareTyping || !jid) return;
    const send=presence=>api('/presence','POST',{jid,presence},15000).catch(()=>{});
    // A gravação para em 5 minutos; o aviso nunca passa disso, mesmo se o fim da gravação não for informado.
    if(active) {const started=Date.now();send('recording');recordingTimer=setInterval(()=>{if(Date.now()-started>330_000) {clearInterval(recordingTimer);recordingTimer=null;return;}send('recording');},4000);}else send('paused');
  }

  // ---------- Notificações de novas mensagens ----------
  function beep() {
    try {const Context=globalThis.AudioContext || globalThis.webkitAudioContext;if(!Context) return;const context=new Context(),tone=context.createOscillator(),gain=context.createGain();
      tone.frequency.value=880;gain.gain.setValueAtTime(.08,context.currentTime);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.35);tone.connect(gain).connect(context.destination);tone.start();tone.stop(context.currentTime+.36);tone.onended=()=>context.close();} catch {}
  }
  function checkNotifications(list) {
    const unread=list.filter(chat=>chat.unread>0 || chat.markedUnread).length;document.title=(unread?`(${unread}) `:'')+'Whats AI · atendimento, CRM e IA';
    for(const chat of list) {
      const last=chat.lastMessage;if(!last || last.fromMe!==false || last.type==='reaction' && !last.reaction?.emoji) continue;
      const stamp=Number(last.timestamp) || 0,previous=notifiedAt.get(chat.jid);notifiedAt.set(chat.jid,Math.max(stamp,previous || 0));
      if(!notificationsReady || previous===undefined || stamp<=previous || muted(chat) || chat.archived) continue;
      const visibleHere=document.visibilityState==='visible' && selected()?.jid===chat.jid;if(visibleHere) continue;
      if(prefs.sound) beep();
      if(prefs.notifications && globalThis.Notification?.permission==='granted') {
        try {const item=new Notification(chat.name,{body:C.previewText(last) || 'Nova mensagem',tag:chat.jid,silent:true});item.onclick=()=>{globalThis.focus?.();C.openChat(chat);item.close();};}catch {}
      }
    }
    notificationsReady=true;
  }
  C.hooks.sync.push(()=>checkNotifications(C.chats()));
  // A atualização normal pausa com a aba oculta; para avisar, uma consulta leve continua enquanto houver avisos ligados.
  setInterval(async()=>{if(document.visibilityState!=='hidden' || (!prefs.notifications && !prefs.sound)) return;try {checkNotifications(await api('/chats'));}catch {}},15000);

  // ---------- Perfil, privacidade e preferências ----------
  const privacyFields=['last','online','profile','status','readreceipts','groupadd'];
  for(const key of ['last','profile','status','groupadd']) {const select=$('privacy-'+key);for(const [value,label] of Object.entries(PRIVACY_LABELS)) {if(key==='groupadd' && value==='none') continue;const option=el('option','',label);option.value=value;select.append(option);}}
  let profile=null;
  async function loadProfile() {
    $('profile-status').textContent='Carregando perfil…';
    try {
      profile=await api('/profile');$('profile-name').value=profile.name || '';$('profile-about').value=profile.about || '';$('profile-phone').textContent=C.phoneLabel(profile.phone);$('profile-business').textContent=profile.isBusiness?'Conta comercial':'';
      $('profile-avatar').textContent=C.initials(profile.name || '?');$('profile-status').textContent='';
      const picture=await api('/avatar?jid='+encodeURIComponent(profile.phone+'@s.whatsapp.net')).catch(()=>null);
      if(picture?.base64) {const image=el('img');image.alt='Sua foto do perfil';image.src=`data:${picture.mimeType};base64,${picture.base64}`;$('profile-avatar').replaceChildren(image);}
    } catch(error) {$('profile-status').textContent=error.message;}
    try {const privacy=await api('/privacy');for(const key of privacyFields) if(privacy[key]) $('privacy-'+key).value=privacy[key];$('privacy-message').textContent='';}
    catch(error) {$('privacy-message').textContent=error.message;}
    try {shareTyping=(await api('/chat-preferences')).shareTyping;$('pref-typing').checked=shareTyping;}catch {}
    $('pref-notifications').checked=prefs.notifications && globalThis.Notification?.permission==='granted';$('pref-sound').checked=prefs.sound;
    await renderBlocked();
  }
  async function renderBlocked() {
    const fragment=document.createDocumentFragment();
    try {
      const rows=await api('/blocked');
      for(const row of rows) {const chat=chatOf(row.jid),item=el('li','blocked-item'),button=el('button','text-button','Desbloquear');button.type='button';
        button.addEventListener('click',async()=>{button.disabled=true;try {const state=await api('/chat-state?jid='+encodeURIComponent(row.jid),'PATCH',{blocked:false});if(chat) Object.assign(chat,state);C.renderChats();notice('Contato desbloqueado.',true);await renderBlocked();}catch(error) {notice(error.message);button.disabled=false;}});
        item.append(el('span','',chat?.name || row.jid.split('@')[0]),button);fragment.append(item);}
      if(!rows.length) fragment.append(el('li','muted','Nenhum contato bloqueado pela central.'));
    } catch(error) {fragment.append(el('li','muted',error.message));}
    $('blocked-list').replaceChildren(fragment);
  }
  $('nav-profile').addEventListener('click',()=>{C.showView('page-profile','nav-profile');loadProfile();});
  $('profile-refresh').addEventListener('click',loadProfile);
  $('profile-save').addEventListener('click',async()=>{
    const input={};const name=$('profile-name').value.trim(),about=$('profile-about').value.trim();
    if(name && name!==(profile?.name || '')) input.name=name;if(about && about!==(profile?.about || '')) input.about=about;
    if(!Object.keys(input).length) {$('profile-status').textContent='Nada para salvar.';return;}
    $('profile-save').disabled=true;$('profile-status').textContent='Salvando…';
    try {await api('/profile','PATCH',input);profile={...profile,...input};$('profile-status').textContent='Perfil atualizado no WhatsApp.';}
    catch(error) {$('profile-status').textContent=error.message;}finally {$('profile-save').disabled=false;}
  });
  $('profile-photo-pick').addEventListener('click',()=>$('profile-photo').click());
  $('profile-photo').addEventListener('change',async()=>{
    const file=$('profile-photo').files[0];$('profile-photo').value='';if(!file) return;
    if(!['image/jpeg','image/png'].includes(file.type) || file.size>5*1024*1024) {$('profile-status').textContent='Escolha uma foto JPG ou PNG de até 5 MB.';return;}
    $('profile-status').textContent='Enviando foto…';
    try {const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Não foi possível ler a foto.'));reader.readAsDataURL(file);});
      await api('/profile/picture','PUT',{base64,mimeType:file.type},60000);$('profile-status').textContent='Foto atualizada no WhatsApp.';await loadProfile();}
    catch(error) {$('profile-status').textContent=error.message;}
  });
  $('profile-photo-remove').addEventListener('click',async()=>{
    if(!confirm('Remover sua foto do perfil no WhatsApp?')) return;
    try {await api('/profile/picture','DELETE');$('profile-avatar').replaceChildren();$('profile-avatar').textContent=C.initials(profile?.name || '?');$('profile-status').textContent='Foto removida.';}
    catch(error) {$('profile-status').textContent=error.message;}
  });
  $('privacy-save').addEventListener('click',async()=>{
    $('privacy-save').disabled=true;$('privacy-message').textContent='Salvando…';
    try {await api('/privacy','PUT',Object.fromEntries(privacyFields.map(key=>[key,$('privacy-'+key).value])),60000);$('privacy-message').textContent='Privacidade atualizada no WhatsApp.';}
    catch(error) {$('privacy-message').textContent=error.message;}finally {$('privacy-save').disabled=false;}
  });
  $('pref-typing').addEventListener('change',async()=>{
    try {shareTyping=(await api('/chat-preferences','PUT',{shareTyping:$('pref-typing').checked})).shareTyping;$('prefs-status').textContent='Preferência salva.';}
    catch(error) {$('pref-typing').checked=shareTyping;$('prefs-status').textContent=error.message;}
  });
  $('pref-notifications').addEventListener('change',async()=>{
    let wanted=$('pref-notifications').checked;
    if(wanted && globalThis.Notification && Notification.permission!=='granted') wanted=(await Notification.requestPermission())==='granted';
    if(wanted && !globalThis.Notification) wanted=false;
    prefs.notifications=wanted;setPref('notifications',wanted);$('pref-notifications').checked=wanted;
    $('prefs-status').textContent=wanted?'Notificações ligadas neste navegador.':$('pref-notifications').checked===false && globalThis.Notification?.permission==='denied'?'O navegador bloqueou as notificações. Libere nas configurações do site.':'Notificações desligadas.';
  });
  $('pref-sound').addEventListener('change',()=>{prefs.sound=$('pref-sound').checked;setPref('sound',prefs.sound);if(prefs.sound) beep();$('prefs-status').textContent=prefs.sound?'Som ligado.':'Som desligado.';});

  // ---------- Integração com o restante da central ----------
  function onSelectChat(chat) {
    if(reply && reply.jid!==chat?.jid) {reply=null;$('reply-bar').hidden=true;}
    if(!$('chat-search-bar').hidden) toggleSearch(false);
    if(!chat) return;renderChatActions();
    if(chat.markedUnread) api('/chat-state?jid='+encodeURIComponent(chat.jid),'PATCH',{markedUnread:false}).then(state=>{for(const target of [chatOf(chat.jid),chat]) if(target) Object.assign(target,state);C.renderChats();renderChatActions();}).catch(()=>{});
  }
  C.hooks.sync.push(()=>{if(selected()) renderChatActions();if(searchState.query) runSearch();});
  globalThis.WhatsAppExtras={
    arrangeChats,decorateChat,extendActions,pendingReactions,resetFilters,
    onChatClick:chat=>globalThis.WhatsAppTeam?.onChatClick?.(chat) || false,
    isStarred:(jid,id)=>starred.has(jid+'|'+id),
    replyFor:jid=>reply?.jid===jid?reply.id:null,
    onSent:jid=>{if(reply?.jid===jid) clearReply();},
    onTyping,onRecording,onSelectChat,
    onAttachment:(file,kind)=>{if(kind==='sticker' && reply) notice('Figurinhas são enviadas sem citação.');},
    clearReply,currentReply:()=>reply
  };
  loadStarred().then(()=>C.renderMessages());
  api('/chat-preferences').then(value=>{shareTyping=value.shareTyping;}).catch(()=>{});
})();
