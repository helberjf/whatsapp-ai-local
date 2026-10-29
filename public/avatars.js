(() => {
  'use strict';
  const cache=new Map(),targets=new Map(),queued=new Set(),queue=[];
  let api,observer,active=0,scheduled=false,fallback=0;
  const initials=name=>String(name || '?').split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase();
  function paint(target,jid,result) {
    if(target.dataset.avatarJid!==jid || !result?.url) return;
    const image=document.createElement('img');image.src=result.url;image.alt='Foto de '+(target.dataset.avatarName || 'contato');image.decoding='async';image.loading='lazy';
    image.addEventListener('error',()=>{if(target.dataset.avatarJid===jid) target.textContent=initials(target.dataset.avatarName);});
    target.textContent='';target.append(image);
  }
  function prune() {
    scheduled=false;
    for(const [target] of targets) if(target.isConnected===false) {observer?.unobserve(target);targets.delete(target);}
  }
  function pump() {
    while(active<3 && queue.length) {
      const jid=queue.shift();
      if(![...targets.entries()].some(([target,contact])=>contact.jid===jid && target.isConnected!==false)) {queued.delete(jid);continue;}
      active++;
      Promise.resolve().then(()=>api('/avatar?jid='+encodeURIComponent(jid))).then(result=>{
        const url=result?.base64 && ['image/jpeg','image/png','image/webp'].includes(result.mimeType)?'data:'+result.mimeType+';base64,'+result.base64:null;
        return {url,expires:Date.now()+(url?3600000:300000)};
      }).catch(()=>({url:null,expires:Date.now()+60000})).then(result=>{
        cache.set(jid,result);if(cache.size>600) cache.delete(cache.keys().next().value);
        for(const [target,contact] of targets) if(contact.jid===jid) {paint(target,jid,result);observer?.unobserve(target);targets.delete(target);}
      }).finally(()=>{active--;queued.delete(jid);pump();});
    }
  }
  function request(jid) {if(!queued.has(jid)) {queued.add(jid);queue.push(jid);}pump();}
  window.WhatsAppAvatars={
    init(options) {
      if(api) return;api=options.api;
      if(window.IntersectionObserver) observer=new window.IntersectionObserver(entries=>{
        for(const entry of entries) if(entry.isIntersecting) {const contact=targets.get(entry.target);if(contact) request(contact.jid);}
      },{root:document.getElementById?.('chat-list') || null,rootMargin:'100px'});
    },
    decorate(target,chat,options={}) {
      if(!target || !chat?.jid || !api) return;
      target.dataset.avatarJid=chat.jid;target.dataset.avatarName=chat.name || 'Contato';target.classList.add('person-avatar');target.textContent=initials(chat.name);
      const saved=cache.get(chat.jid);
      if(saved && saved.expires>Date.now()) {paint(target,chat.jid,saved);return;}
      targets.set(target,{jid:chat.jid});
      if(options.eager) request(chat.jid);
      else if(observer) observer.observe(target);
      else if(fallback++<20) request(chat.jid);
      if(!scheduled) {scheduled=true;queueMicrotask(prune);}
    }
  };
})();
