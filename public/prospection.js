(()=>{
  'use strict';
  const C=globalThis.WhatsAppCentral;if(!C) return;
  const {$,el,api,notice}=C;
  let items=[],systemUrl='',loaded=false,busy=false;
  const dirty=()=>items.some(item=>item.body!==item.original);
  const inbox=item=>{try {const url=new URL(systemUrl);url.pathname='/inbox';url.search='?c='+encodeURIComponent(item.conversationId);return url.href;}catch {return '#';}};
  function status(text) {$('prospection-status').textContent=text;}
  function card(item) {
    const article=el('article','panel prospection-card'),head=el('div','prospection-card-head'),identity=el('div'),actions=el('div','prospection-card-actions');
    identity.append(el('strong','',item.name || item.phone),el('small','',item.phone));
    const open=el('a','text-button','Abrir no sistema');open.href=inbox(item);open.target='_blank';open.rel='noopener noreferrer';
    const save=el('button','button secondary','Salvar rascunho');save.type='button';
    const result=el('p','prospection-card-status');result.setAttribute('role','status');
    actions.append(open,save);head.append(identity,actions);
    const label=el('label','field','Mensagem revisada'),textarea=el('textarea');textarea.rows=6;textarea.maxLength=10000;textarea.value=item.body;label.append(textarea);
    textarea.addEventListener('input',()=>{item.body=textarea.value;result.textContent=item.body===item.original?'':'Alteração ainda não salva.';});
    save.addEventListener('click',async()=>{
      if(busy || !item.body.trim()) return;busy=true;save.disabled=true;result.textContent='Salvando…';
      try {await api('/prospection/drafts','PATCH',{messageId:item.messageId,body:item.body,expectedBody:item.original});item.original=item.body;result.textContent='Rascunho salvo.';status('Rascunho salvo na prospecção.');}
      catch(error) {result.textContent=error.message;notice(error.message);}
      finally {busy=false;save.disabled=false;}
    });
    article.append(head,label,result);return article;
  }
  function render() {
    const fragment=document.createDocumentFragment();for(const item of items) fragment.append(card(item));
    if(!items.length) fragment.append(el('div','panel prospection-empty','Nenhum rascunho aguardando revisão.'));
    $('prospection-list').replaceChildren(fragment);
    $('prospection-open').href=systemUrl || '#';$('prospection-open').hidden=!systemUrl;
  }
  async function load(method='GET') {
    if(busy) return;if(dirty()) {status('Salve os rascunhos alterados antes de atualizar ou preparar.');return;}
    busy=true;$('prospection-refresh').disabled=true;$('prospection-prepare').disabled=true;status(method==='POST'?'Preparando rascunhos…':'Carregando rascunhos…');
    try {const data=await api('/prospection/drafts',method,method==='POST'?{}:undefined,method==='POST'?100000:20000);systemUrl=data.systemUrl || '';items=data.items.map(item=>({...item,original:item.body}));loaded=true;render();status(items.length?items.length+' rascunho(s) pronto(s) para revisão.':'Nenhum rascunho aguardando revisão.');$('prospection-prepare').disabled=false;}
    catch(error) {items=[];render();status(error.message);$('prospection-prepare').disabled=true;}
    finally {busy=false;$('prospection-refresh').disabled=false;}
  }
  function show() {C.showView('page-prospection');$('page-prospection').hidden=false;$('nav-prospection').classList.add('active');if(!loaded) load();}
  C.hooks.view.push(view=>{$('page-prospection').hidden=view!=='page-prospection';$('nav-prospection').classList.toggle('active',view==='page-prospection');});
  $('nav-prospection').addEventListener('click',show);$('prospection-refresh').addEventListener('click',()=>load('GET'));$('prospection-prepare').addEventListener('click',()=>load('POST'));
  if(new URLSearchParams(location.search).has('prospeccao')) show();
})();
