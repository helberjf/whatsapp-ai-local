(()=>{
  let api,notice,render,state={version:1,pinned:[],normal:[]},dragged=null;
  const pinned=jid=>state.pinned.includes(jid);
  const clone=()=>({version:1,pinned:[...state.pinned],normal:[...state.normal]});
  function arrange(chats) {
    const byId=new Map(chats.map(chat=>[chat.jid,chat])),ordered=[];
    for(const jid of [...state.pinned,...state.normal]) if(byId.has(jid)) {ordered.push(byId.get(jid));byId.delete(jid);}
    return [...ordered,...byId.values()];
  }
  async function refresh() {
    try {state=await api('/group-presentation');render?.();}catch(error) {notice?.(error.message);}
    return state;
  }
  async function toggle(chat) {
    const before=clone(),willPin=!pinned(chat.jid);
    state.pinned=state.pinned.filter(id=>id!==chat.jid);state.normal=state.normal.filter(id=>id!==chat.jid);
    (willPin?state.pinned:state.normal).unshift(chat.jid);render?.();
    try {state=await api('/group-presentation/pin','PATCH',{jid:chat.jid,pinned:willPin});render?.();}
    catch(error) {state=before;render?.();notice?.(error.message);}
  }
  async function persistOrder(container,target,beforeTarget) {
    if(!dragged || dragged===target || pinned(dragged)!==pinned(target)) {if(dragged && target && pinned(dragged)!==pinned(target)) notice?.('Use o menu para fixar ou desafixar antes de mover entre os blocos.');return;}
    const snapshot=clone(),block=pinned(dragged)?state.pinned:state.normal;
    const source=block.indexOf(dragged),destination=block.indexOf(target);if(source<0 || destination<0) return;
    block.splice(source,1);let index=block.indexOf(target)+(beforeTarget?0:1);block.splice(index,0,dragged);render?.();
    try {state=await api('/group-presentation','PUT',{pinned:state.pinned,normal:state.normal});render?.();}
    catch(error) {state=snapshot;render?.();notice?.(error.message);}
  }
  function wrap(button,chat) {
    const row=document.createElement('div');row.className='group-chat-row'+(pinned(chat.jid)?' pinned':'');row.dataset.jid=chat.jid;row.draggable=true;
    const menu=document.createElement('button');menu.type='button';menu.className='group-menu-button';menu.textContent='☰';menu.setAttribute('aria-label',`Opções do grupo ${chat.name}`);menu.title=pinned(chat.jid)?'Desafixar grupo':'Fixar grupo';
    menu.addEventListener('click',event=>{event.stopPropagation();toggle(chat);});
    row.addEventListener('dragstart',event=>{dragged=chat.jid;row.classList.add('dragging');event.dataTransfer?.setData('text/plain',chat.jid);});
    row.addEventListener('dragend',()=>{dragged=null;row.classList.remove('dragging');});
    row.addEventListener('dragover',event=>{if(dragged) event.preventDefault();});
    row.addEventListener('drop',event=>{event.preventDefault();const box=row.getBoundingClientRect?.() || {top:0,height:1};persistOrder(row.parentElement,chat.jid,event.clientY<box.top+box.height/2);});
    row.append(button,menu);return row;
  }
  function init(input) {api=input.api;notice=input.notice;render=input.render;return refresh();}
  globalThis.WhatsAppGroups={init,arrange,wrap,refresh};
})();
