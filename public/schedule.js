(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const labels={scheduled:'Programada',sending:'Enviando',sent:'Enviada',cancelled:'Cancelada',missed:'Não enviada · remarcar',uncertain:'Envio sem confirmação'};
  const editable=job=>['scheduled','missed','cancelled'].includes(job.status);
  const normalize=value=>String(value || '').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
  const dateLabel=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'Horário não definido';
  let hooks,initialized=false,chats=[],jobs=[],activeKey='sidebar',formState=null,timer=null,busy=false,loading=false,listVersion=0;
  const drafts=new Map(),pendingActions=new Set();
  function node(tag,className,text,id) {const value=document.createElement(tag);if(className) value.className=className;if(text!==undefined) value.textContent=text;if(id) value.id=id;return value;}
  function button(text,action,className='button secondary',id) {const value=node('button',className,text,id);value.type='button';value.addEventListener('click',action);return value;}
  function field(text,input) {const value=node('label','field',text);value.append(input);return value;}
  function input(id,type,maxLength) {const value=node('input','',undefined,id);value.type=type;if(maxLength) value.maxLength=maxLength;return value;}
  function option(select,value,label) {const item=node('option','',label);item.value=value;select.append(item);}
  function phone(chat) {
    const raw=String(chat?.phone || (chat?.jid?.endsWith('@s.whatsapp.net')?chat.jid.split('@')[0]:''));
    const digits=raw.replace(/\D/g,'');if(chat?.jid?.endsWith('@lid') && digits===chat.jid.split('@')[0]) return '';
    return /^\d{8,15}$/.test(digits)?'+'+digits:'';
  }
  function name(chat) {
    const raw=String(chat?.name || '').trim(),jid=String(chat?.jid || '');
    if(raw && raw!==jid && !(jid.endsWith('@lid') && raw===jid.split('@')[0])) return raw;
    return phone(chat) || (jid.endsWith('@lid')?'Contato · ID '+jid.split('@')[0]:'Contato WhatsApp');
  }
  function contact(jid) {return chats.find(chat=>chat.jid===jid) || {jid};}
  function contactLabel(chat) {const title=name(chat),number=phone(chat);return number && title!==number && title!==number.slice(1)?title+' · '+number:title;}
  function blank() {return {jid:'',text:'',at:'',search:'',editingId:null,snapshot:null,requestId:null,fingerprint:null};}
  function status(id,text,error=false) {$(id).textContent=text;$(id).className='schedule-status'+(error?' schedule-error':'');}
  function saveDraft() {
    if(!formState) return;
    Object.assign(formState,{jid:$('schedule-recipient').value,text:$('schedule-text').value,at:$('schedule-at').value,search:$('schedule-recipient-search').value});drafts.set(activeKey,formState);
  }
  function updateSummary() {
    const jid=$('schedule-recipient').value,at=$('schedule-at').value;
    $('schedule-confirmation').textContent=jid && at?'Para '+contactLabel(contact(jid))+' em '+dateLabel(at)+'.':'Escolha um contato, escreva a mensagem e defina a data e o horário.';
  }
  function renderRecipients() {
    const select=$('schedule-recipient'),selected=select.value || formState?.jid || '',search=normalize($('schedule-recipient-search').value);
    select.replaceChildren();option(select,'','Selecione um contato');
    const eligible=chats.filter(chat=>/@(?:s\.whatsapp\.net|lid)$/.test(chat.jid));
    const filtered=eligible.filter(chat=>chat.jid===selected || !search || normalize(contactLabel(chat)).includes(search));
    for(const chat of filtered) option(select,chat.jid,contactLabel(chat));
    if(selected && !eligible.some(chat=>chat.jid===selected)) option(select,selected,contactLabel(contact(selected)));
    select.value=selected;
  }
  function showForm(key,state) {
    saveDraft();activeKey=key;formState=drafts.get(key) || state || blank();drafts.set(key,formState);
    $('schedule-recipient-search').value=formState.search;$('schedule-recipient').value=formState.jid;renderRecipients();
    $('schedule-text').value=formState.text;$('schedule-at').value=formState.at;
    $('schedule-recipient').disabled=!!formState.editingId;$('schedule-recipient-search').disabled=!!formState.editingId;
    $('schedule-form-title').textContent=formState.editingId?'Editar programação':'Programar mensagem';
    $('schedule-submit').textContent=formState.editingId?'Salvar programação':'Programar mensagem';
    const attachment=!!formState.snapshot?.hasAttachment;
    $('schedule-attachment-note').textContent=attachment?'Agendamento disponível para texto; anexo não será incluído.':'';
    $('schedule-attachment-note').hidden=!attachment;status('schedule-form-status','');updateSummary();
  }
  function startPoll() {
    clearTimeout(timer);timer=null;if(!$('schedule-dialog').open) return;
    timer=setTimeout(async()=>{timer=null;if(!$('schedule-dialog').open) return;await loadJobs();startPoll();},10000);
  }
  async function loadJobs() {
    if(loading) return;loading=true;const version=++listVersion;
    try {const result=await hooks.api('/scheduled-messages');if(version===listVersion) {jobs=Array.isArray(result)?result:[];renderList();status('schedule-load-status','');}}
    catch(error) {if(version===listVersion) status('schedule-load-status',error.message || 'Não foi possível carregar as programações.',true);}
    finally {loading=false;}
  }
  async function open(source) {
    if(busy) return;
    if(source==='composer') {
      const selected=hooks.getSelected?.();if(!selected || !/@(?:s\.whatsapp\.net|lid)$/.test(selected.jid)) {hooks.notice('Selecione uma conversa individual para programar uma mensagem.');return;}
      const snapshot={...hooks.getDraft(),jid:selected.jid},state={...blank(),jid:selected.jid,text:snapshot.text,snapshot};showForm('chat:'+selected.jid,state);
    } else showForm('sidebar',blank());
    if(!$('schedule-dialog').open) $('schedule-dialog').showModal();status('schedule-load-status','Carregando programações…');
    await loadJobs();startPoll();
  }
  function localDate(value) {const date=new Date(value);return Number.isFinite(date.getTime())?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):'';}
  function edit(job) {
    if(busy || !editable(job)) return;
    showForm('edit:'+job.id,{...blank(),jid:job.jid,text:job.text,at:localDate(job.scheduledAt),editingId:job.id});$('schedule-text').focus();
  }
  function upsert(job) {listVersion++;const index=jobs.findIndex(item=>item.id===job.id);if(index<0) jobs.push(job);else jobs[index]=job;renderList();}
  async function cancel(job) {
    if(busy || job.status!=='scheduled' || pendingActions.has(job.id)) return;
    pendingActions.add(job.id);renderList();
    try {upsert(await hooks.api('/scheduled-messages/'+encodeURIComponent(job.id)+'/cancel','POST',{}));hooks.notice('Programação cancelada.',true);}
    catch(error) {await loadJobs();status('schedule-load-status',error.message,true);}
    finally {pendingActions.delete(job.id);renderList();}
  }
  function renderList() {
    const list=$('schedule-list'),search=normalize($('schedule-search').value),filter=$('schedule-filter').value;
    const upcoming=jobs.filter(job=>job.status==='scheduled').length;$('schedule-summary').textContent=upcoming+' '+(upcoming===1?'mensagem programada':'mensagens programadas');
    const filtered=jobs.filter(job=>(!filter || job.status===filter) && (!search || normalize(contactLabel(contact(job.jid))+' '+job.text).includes(search))).sort((a,b)=>Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt));
    list.replaceChildren();
    if(!filtered.length) {list.append(node('p','schedule-empty',jobs.length?'Nenhuma programação corresponde aos filtros.':'Nenhuma mensagem programada. Escolha um contato e um horário para começar.'));return;}
    for(const job of filtered) {
      const card=node('article','schedule-job'),heading=node('div','schedule-job-heading'),badge=node('span','schedule-badge',labels[job.status] || job.status);badge.dataset.status=job.status;
      heading.append(node('strong','',contactLabel(contact(job.jid))),badge);const time=node('time','schedule-time',dateLabel(job.scheduledAt));time.dateTime=job.scheduledAt;
      card.append(heading,time,node('p','schedule-message',job.text));
      if(job.status==='uncertain') card.append(node('p','schedule-warning','Confira a conversa no WhatsApp antes de programar outra mensagem: o envio pode ter acontecido.'));
      else if(job.status==='missed') card.append(node('p','schedule-warning','O horário passou há mais de 15 minutos. Edite a programação para escolher outro horário.'));
      if(job.lastError) card.append(node('p','schedule-job-error',job.lastError));
      const actions=node('div','schedule-job-actions');
      if(editable(job)) actions.append(button(job.status==='scheduled'?'Editar':'Remarcar',()=>edit(job),'text-button'));
      if(job.status==='scheduled') {const stop=button(pendingActions.has(job.id)?'Cancelando…':'Cancelar',()=>cancel(job),'text-button schedule-cancel');stop.disabled=pendingActions.has(job.id);actions.append(stop);}
      if(actions.children.length) card.append(actions);list.append(card);
    }
  }
  async function submit(event) {
    event.preventDefault();if(busy) return;saveDraft();const state=formState,jid=state.jid,text=state.text,when=new Date(state.at);
    if(state.editingId && !editable(jobs.find(job=>job.id===state.editingId) || {})) {status('schedule-form-status','Esta mensagem não pode mais ser editada. Confira a situação na lista.',true);return;}
    if(!jid || !/@(?:s\.whatsapp\.net|lid)$/.test(jid)) {status('schedule-form-status','Selecione um contato individual.',true);return;}
    if(!text.trim() || text.length>10000) {status('schedule-form-status','Escreva uma mensagem de até 10.000 caracteres.',true);return;}
    if(!state.at || !Number.isFinite(when.getTime()) || when.getTime()<=Date.now()) {status('schedule-form-status','Escolha uma data e um horário no futuro.',true);return;}
    const scheduledAt=when.toISOString(),fingerprint=JSON.stringify([jid,text,scheduledAt]);
    if(!state.requestId || state.fingerprint!==fingerprint) {state.requestId=crypto.randomUUID();state.fingerprint=fingerprint;}
    busy=true;setFormBusy(true);status('schedule-form-status','Salvando programação…');
    try {
      const job=state.editingId?await hooks.api('/scheduled-messages/'+encodeURIComponent(state.editingId),'PATCH',{text,scheduledAt}):await hooks.api('/scheduled-messages','POST',{jid,text,scheduledAt,requestId:state.requestId});
      upsert(job);const snapshot=state.snapshot;
      if(!state.editingId && snapshot && !snapshot.hasAttachment && snapshot.jid===jid && snapshot.text===text) hooks.onScheduled?.(job,snapshot);
      const savedKey=activeKey;drafts.delete(savedKey);formState=null;showForm('sidebar',drafts.get('sidebar') || blank());
      hooks.notice('Mensagem programada para '+contactLabel(contact(job.jid))+' em '+dateLabel(job.scheduledAt)+'.',true);
    } catch(error) {status('schedule-form-status',error.message || 'Não foi possível salvar. Tente novamente para confirmar esta mesma programação.',true);}
    finally {busy=false;setFormBusy(false);}
  }
  function setFormBusy(value) {
    for(const id of ['schedule-submit','schedule-text','schedule-at','schedule-new']) $(id).disabled=value;
    for(const id of ['schedule-recipient','schedule-recipient-search']) $(id).disabled=value || !!formState?.editingId;
  }
  function build() {
    const nav=button('',()=>open('sidebar'),'nav-item','nav-schedule');nav.title='Mensagens programadas';nav.setAttribute('aria-label','Mensagens programadas');
    const icon=node('span','schedule-nav-icon','◷');icon.setAttribute('aria-hidden','true');nav.append(icon,node('span','','Mensagens programadas'));document.querySelector('.main-nav')?.append(nav);
    const composer=$('composer'),quick=composer?.querySelector('.quick-reply');
    if(composer) {const toolbar=node('div','schedule-composer-toolbar');composer.insertBefore(toolbar,quick || composer.children[0]);if(quick) toolbar.append(quick);toolbar.append(button('◷ Programar',()=>open('composer'),'schedule-composer-button','schedule-message-button'));}
    const dialog=node('dialog','schedule-dialog',undefined,'schedule-dialog');dialog.setAttribute('aria-labelledby','schedule-title');
    const head=node('div','dialog-heading'),title=node('div');title.append(node('p','eyebrow','NO HORÁRIO QUE VOCÊ ESCOLHER'),node('h2','','Mensagens programadas','schedule-title'));
    const close=button('×',()=>dialog.close(),'icon-button');close.setAttribute('aria-label','Fechar mensagens programadas');head.append(title,close);dialog.append(head);
    dialog.append(node('p','schedule-intro','Computador e WhatsApp precisam estar ligados/conectados. Após 15 minutos de atraso, a mensagem fica não enviada para você remarcar.'));
    const layout=node('div','schedule-layout'),form=node('form','schedule-form',undefined,'schedule-form');form.append(node('h3','','Programar mensagem','schedule-form-title'));
    const search=input('schedule-recipient-search','search',160);search.placeholder='Nome ou telefone';search.autocomplete='off';search.addEventListener('input',()=>{saveDraft();renderRecipients();});
    const recipient=node('select','',undefined,'schedule-recipient');recipient.required=true;recipient.addEventListener('change',()=>{saveDraft();updateSummary();});
    form.append(field('Buscar contato',search),field('Destinatário',recipient));
    const text=node('textarea','',undefined,'schedule-text');text.rows=5;text.maxLength=10000;text.required=true;text.placeholder='Escreva a mensagem que será enviada';text.addEventListener('input',saveDraft);
    const at=input('schedule-at','datetime-local');at.required=true;at.addEventListener('input',()=>{saveDraft();updateSummary();});
    form.append(field('Mensagem de texto',text),node('p','schedule-warning','','schedule-attachment-note'),field('Data e horário neste computador',at),node('p','schedule-confirmation','','schedule-confirmation'),node('p','schedule-status','','schedule-form-status'));
    const submitButton=node('button','button primary full','Programar mensagem','schedule-submit');submitButton.type='submit';form.append(submitButton,button('Nova programação',()=>{if(busy) return;saveDraft();drafts.delete('sidebar');formState=null;showForm('sidebar',blank());},'text-button schedule-new','schedule-new'));form.addEventListener('submit',submit);
    const listPanel=node('section','schedule-list-panel'),listTitle=node('div','schedule-list-heading');listTitle.append(node('h3','','Suas programações'),node('span','schedule-count','','schedule-summary'));listPanel.append(listTitle);
    const filters=node('div','schedule-filters'),listSearch=input('schedule-search','search',160);listSearch.placeholder='Buscar contato ou mensagem';listSearch.setAttribute('aria-label','Buscar programações');listSearch.addEventListener('input',renderList);
    const filter=node('select','',undefined,'schedule-filter');filter.setAttribute('aria-label','Filtrar situação');option(filter,'','Todas as situações');for(const [value,label] of Object.entries(labels)) option(filter,value,label);filter.addEventListener('change',renderList);filters.append(listSearch,filter);
    listPanel.append(filters,node('p','schedule-status','','schedule-load-status'),node('div','schedule-list',undefined,'schedule-list'));layout.append(form,listPanel);dialog.append(layout);document.body.append(dialog);
    dialog.addEventListener('close',()=>{saveDraft();clearTimeout(timer);timer=null;});dialog.addEventListener('cancel',event=>{if(busy) event.preventDefault();});
    formState=blank();renderRecipients();$('schedule-attachment-note').hidden=true;updateSummary();renderList();
  }
  globalThis.WhatsAppSchedule={
    init(options) {if(initialized) return;hooks=options;chats=hooks.getChats?.() || [];initialized=true;build();this.onSelectChat(hooks.getSelected?.() || null);},
    onChats(value) {chats=value || [];if(!initialized) return;if($('schedule-dialog').open) {saveDraft();renderRecipients();renderList();updateSummary();}},
    onSelectChat(chat) {if(!initialized || !$('schedule-message-button')) return;$('schedule-message-button').disabled=!chat || !/@(?:s\.whatsapp\.net|lid)$/.test(chat.jid);}
  };
})();
