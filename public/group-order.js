(()=>{
  let api,notice,render,state={version:2,pinned:[],normal:[],archived:[]},dragged=null,openMenu=null;
  const pinned=jid=>state.pinned.includes(jid),isArchived=jid=>state.archived.includes(jid);
  const clone=()=>({version:2,pinned:[...state.pinned],normal:[...state.normal],archived:[...state.archived]});
  const active=chats=>chats.filter(chat=>!isArchived(chat.jid));
  const archived=chats=>chats.filter(chat=>isArchived(chat.jid));
  function arrange(chats) {
    const byId=new Map(chats.map(chat=>[chat.jid,chat])),ordered=[];
    for(const jid of [...state.pinned,...state.normal,...state.archived]) if(byId.has(jid)) {ordered.push(byId.get(jid));byId.delete(jid);}
    return [...ordered,...byId.values()];
  }
  function closeMenu(focus=false) {
    if(!openMenu) return;const current=openMenu;openMenu=null;current.menu.hidden=true;current.toggle.setAttribute('aria-expanded','false');if(focus) current.toggle.focus();
  }
  async function refresh() {
    try {state=await api('/group-presentation');render?.();}catch(error) {notice?.(error.message);}
    return state;
  }
  async function togglePin(chat) {
    const before=clone(),willPin=!pinned(chat.jid);closeMenu();
    state.pinned=state.pinned.filter(id=>id!==chat.jid);state.normal=state.normal.filter(id=>id!==chat.jid);
    (willPin?state.pinned:state.normal).unshift(chat.jid);render?.();
    try {state=await api('/group-presentation/pin','PATCH',{jid:chat.jid,pinned:willPin});render?.();}
    catch(error) {state=before;render?.();notice?.(error.message);}
  }
  async function toggleArchive(chat) {
    const before=clone(),willArchive=!isArchived(chat.jid);closeMenu();
    state.pinned=state.pinned.filter(id=>id!==chat.jid);state.normal=state.normal.filter(id=>id!==chat.jid);state.archived=state.archived.filter(id=>id!==chat.jid);
    (willArchive?state.archived:state.normal).unshift(chat.jid);render?.();
    try {state=await api('/group-presentation/archive','PATCH',{jid:chat.jid,archived:willArchive});render?.();notice?.(willArchive?'Grupo arquivado. Veja em “Grupos arquivados”.':'Grupo desarquivado.',true);}
    catch(error) {state=before;render?.();notice?.(error.message);}
  }
  function blockOf(jid) {return state.pinned.includes(jid)?'pinned':state.normal.includes(jid)?'normal':state.archived.includes(jid)?'archived':null;}
  async function persistOrder(target,beforeTarget) {
    const sourceBlock=blockOf(dragged),targetBlock=blockOf(target);
    if(!dragged || dragged===target || !sourceBlock || sourceBlock!==targetBlock) {if(dragged && target && sourceBlock!==targetBlock) notice?.('Use o menu para fixar, desafixar, arquivar ou desarquivar antes de mover entre os blocos.');return;}
    const snapshot=clone(),block=state[sourceBlock],source=block.indexOf(dragged),destination=block.indexOf(target);if(source<0 || destination<0) return;
    block.splice(source,1);const index=block.indexOf(target)+(beforeTarget?0:1);block.splice(index,0,dragged);render?.();
    try {state=await api('/group-presentation','PUT',{pinned:state.pinned,normal:state.normal,archived:state.archived});render?.();}
    catch(error) {state=snapshot;render?.();notice?.(error.message);}
  }
  function action(text,handler) {const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=text;button.addEventListener('click',event=>{event.stopPropagation();handler();});return button;}
  function wrap(button,chat) {
    const row=document.createElement('div'),archivedGroup=isArchived(chat.jid);row.className='group-chat-row'+(pinned(chat.jid)?' pinned':'');row.dataset.jid=chat.jid;row.draggable=true;
    const toggle=document.createElement('button');toggle.type='button';toggle.className='group-menu-button';toggle.textContent='☰';toggle.setAttribute('aria-label',`Opções do grupo ${chat.name}`);toggle.setAttribute('aria-haspopup','menu');toggle.setAttribute('aria-expanded','false');toggle.title='Opções do grupo';
    const menu=document.createElement('div');menu.className='group-action-menu';menu.setAttribute('role','menu');menu.hidden=true;
    if(!archivedGroup) menu.append(action(pinned(chat.jid)?'Desafixar grupo':'Fixar grupo',()=>togglePin(chat)),action('Arquivar grupo',()=>toggleArchive(chat)));
    else menu.append(action('Desarquivar grupo',()=>toggleArchive(chat)));
    toggle.addEventListener('click',event=>{event.stopPropagation();if(openMenu?.menu===menu) return closeMenu(true);closeMenu();menu.hidden=false;toggle.setAttribute('aria-expanded','true');openMenu={menu,toggle};menu.querySelector('button')?.focus();});
    row.addEventListener('dragstart',event=>{closeMenu();dragged=chat.jid;row.classList.add('dragging');event.dataTransfer?.setData('text/plain',chat.jid);});
    row.addEventListener('dragend',()=>{dragged=null;row.classList.remove('dragging');});
    row.addEventListener('dragover',event=>{if(dragged) event.preventDefault();});
    row.addEventListener('drop',event=>{event.preventDefault();const box=row.getBoundingClientRect?.() || {top:0,height:1};persistOrder(chat.jid,event.clientY<box.top+box.height/2);});
    row.append(button,toggle,menu);return row;
  }
  function init(input) {
    api=input.api;notice=input.notice;render=input.render;
    document.addEventListener('click',event=>{if(openMenu && !openMenu.menu.contains(event.target) && event.target!==openMenu.toggle) closeMenu();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape' && openMenu) {event.preventDefault();closeMenu(true);}});
    return refresh();
  }
  globalThis.WhatsAppGroups={init,active,archived,arrange,wrap,refresh};
})();
