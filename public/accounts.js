(() => {
  'use strict';
  const $=id=>document.getElementById(id),KEY='whats-ai-conta';
  const ids=(document.querySelector('meta[name="whatsapp-accounts"]')?.content || '').split(',').filter(Boolean);
  // A aba mantém a própria conta; o último uso vale para as abas novas.
  function stored() {try {return sessionStorage.getItem(KEY) || localStorage.getItem(KEY);}catch {return null;}}
  function remember(id) {try {sessionStorage.setItem(KEY,id);localStorage.setItem(KEY,id);}catch {}}
  // Fixada ao carregar a página: tudo o que esta tela envia sai pela conta que ela mostra.
  const requested=new URLSearchParams(location.search).get('conta');
  const active=ids.includes(requested)?requested:ids.includes(stored())?stored():ids[0];
  let accounts=[],api=null,notice=()=>{},naming=null,removing=null,loading=null;
  const labels={connected:'Conectada',connecting:'Aguardando QR Code'};
  const stateLabel=account=>labels[account.state] || (account.reachable?'Desconectada':'Conector indisponível');
  const phone=value=>value?'+'+value:'Sem número pareado';
  function el(tag,className,text) {const node=document.createElement(tag);if(className) node.className=className;if(text!==undefined) node.textContent=text;return node;}
  function button(text,className,action) {const node=el('button',className,text);node.type='button';node.addEventListener('click',action);return node;}
  function open(id,connect=false) {
    if(id===active && !connect) {$('accounts-dialog').close();return;}
    const draft=$('message-text')?.value.trim();
    if(draft && !confirm('Trocar de conta descarta o texto que está no editor. Continuar?')) return;
    remember(id);location.assign(connect?'/?conectar':'/');
  }
  function row(account) {
    const item=el('li','account-row'+(account.id===active?' active':'')),copy=el('div','account-copy'),title=el('div','account-title'),dot=el('i','dot'+(account.state==='connected'?' on':'')),actions=el('div','account-actions');
    title.append(dot,el('strong','',account.name));if(account.id===active) title.append(el('span','account-badge','Em uso'));
    copy.append(title,el('small','',`${phone(account.phone)} · ${stateLabel(account)}`));
    if(account.duplicatePhone) copy.append(el('small','account-warning','Este número também está em outra conta. Desconecte uma delas para evitar respostas duplicadas.'));
    if(account.id!==active) actions.append(button('Usar esta conta','button primary compact',()=>open(account.id)));
    if(account.state==='connected') actions.append(button('Desconectar','button secondary compact',()=>disconnect(account)));
    else actions.append(button('Conectar','button secondary compact',()=>open(account.id,true)));
    actions.append(button('Renomear','text-button',()=>askName(account)),button('Remover','text-button account-remove',()=>askRemoval(account)));
    item.append(copy,actions);return item;
  }
  function render() {
    const current=accounts.find(account=>account.id===active);
    if(current) {
      $('account-name').textContent=current.name;$('account-state').textContent=stateLabel(current);$('account-dot').classList.toggle('on',current.state==='connected');
      $('account-switcher').title='Conta em uso: '+current.name;$('qr-title').textContent='Conectar '+current.name;
      const hint=$('composer-account');if(hint) hint.textContent='Enviando por: '+current.name;
    }
    if($('accounts-dialog').open) {const list=document.createDocumentFragment();accounts.forEach(account=>list.append(row(account)));$('accounts-list').replaceChildren(list);}
  }
  // Depois de uma alteração, uma consulta já em andamento pode trazer a lista antiga: espera e consulta de novo.
  function load(fresh=false) {
    if(fresh && loading) return loading.catch(()=>{}).then(()=>load());
    if(!loading) loading=api('/accounts').then(rows=>{accounts=rows;render();}).finally(()=>{loading=null;});
    return loading;
  }
  async function disconnect(account) {
    if(!confirm(`Desconectar ${account.name}? Para usar novamente será necessário ler outro QR Code. O histórico salvo será mantido e as outras contas não mudam.`)) return;
    $('accounts-status').textContent='Desconectando…';
    try {await api(`/accounts/${account.id}/disconnect`,'POST',{});await load(true);$('accounts-status').textContent=account.name+' foi desconectada.';}
    catch(error) {$('accounts-status').textContent=error.message;}
  }
  function askName(account=null) {
    naming=account;$('account-name-title').textContent=account?'Renomear conta':'Adicionar conta';$('account-name-input').value=account?.name || '';$('account-name-error').textContent='';
    $('account-name-save').textContent=account?'Salvar nome':'Continuar para o QR Code';$('account-name-dialog').showModal();
  }
  function askRemoval(account) {
    removing=account;$('account-remove-name').textContent=account.name;$('account-remove-input').value='';$('account-remove-input').placeholder=account.name;$('account-remove-error').textContent='';$('account-remove-confirm').disabled=true;$('account-remove-dialog').showModal();
  }
  function init(options) {
    ({api,notice}=options);
    const hint=document.querySelector('.composer-hint');if(hint) {const label=el('span','composer-account');label.id='composer-account';hint.append(label);}
    $('account-switcher').addEventListener('click',async()=>{$('accounts-status').textContent='';$('accounts-dialog').showModal();render();try {await load();}catch(error) {$('accounts-status').textContent=error.message;}});
    $('account-add').addEventListener('click',()=>askName());
    $('account-name-form').addEventListener('submit',async event=>{
      event.preventDefault();const save=$('account-name-save'),target=naming;save.disabled=true;$('account-name-error').textContent='';
      try {
        const name=$('account-name-input').value;
        if(target) {await api('/accounts/'+target.id,'PATCH',{name});$('account-name-dialog').close();await load(true);}
        else {const created=await api('/accounts','POST',{name});$('account-name-dialog').close();open(created.id,true);}
      } catch(error) {$('account-name-error').textContent=error.message;}
      finally {save.disabled=false;}
    });
    $('account-remove-input').addEventListener('input',()=>{$('account-remove-confirm').disabled=$('account-remove-input').value.trim()!==removing?.name;});
    $('account-remove-confirm').addEventListener('click',async()=>{
      const target=removing,confirmButton=$('account-remove-confirm');if(!target || confirmButton.disabled) return;confirmButton.disabled=true;$('account-remove-error').textContent='';
      try {
        await api('/accounts/'+target.id,'DELETE');$('account-remove-dialog').close();
        if(target.id===active) {remember(accounts.find(account=>account.id!==active)?.id || '');location.assign('/');return;}
        await load(true);$('accounts-status').textContent=target.name+' foi removida.';
      } catch(error) {$('account-remove-error').textContent=error.message;confirmButton.disabled=false;}
    });
    const refresh=()=>{if(document.visibilityState!=='hidden') load().catch(error=>notice(error.message));};
    refresh();setInterval(refresh,8000);
  }
  globalThis.WhatsAppAccounts={init,headers:()=>active?{'X-WhatsApp-Account':active}:{}};
})();
