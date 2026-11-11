(()=>{
  const $=id=>document.getElementById(id);
  let context,selected=null,items=[],page=1,pages=1,generation=0,controller=null,viewerUrl=null;
  function ensurePreview() {
    if($('contact-media-preview')) return;
    const section=document.createElement('section');section.className='contact-media-preview';section.innerHTML='<div class="contact-media-heading"><h3>Mídias enviadas</h3><button id="contact-media-all" class="text-button" type="button">Ver tudo</button></div><div id="contact-media-preview" class="contact-media-grid"><span class="muted small">Nenhuma mídia carregada.</span></div>';
    $('contact-details')?.querySelector('.contact-identity')?.after(section);$('contact-media-all')?.addEventListener('click',openGallery);
  }
  const thumb=item=>typeof item.jpegThumbnail==='string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item.jpegThumbnail)?'data:image/jpeg;base64,'+item.jpegThumbnail:null;
  function tile(item) {
    const button=document.createElement('button');button.type='button';button.className='contact-media-tile';button.setAttribute('aria-label',`Abrir ${item.type==='video'?'vídeo':'imagem'} de ${new Date(item.timestamp).toLocaleDateString('pt-BR')}`);
    const url=thumb(item);if(url) {const image=document.createElement('img');image.src=url;image.alt='';button.append(image);} else button.textContent=item.type==='video'?'▶ Vídeo':'▧ Foto';
    if(item.type==='video') {const badge=document.createElement('span');badge.textContent='▶';button.append(badge);}
    button.addEventListener('click',()=>openItem(item));return button;
  }
  function render() {
    ensurePreview();const preview=$('contact-media-preview');if(preview) preview.replaceChildren(...(items.slice(0,3).map(tile)));if(preview && !items.length) preview.append(Object.assign(document.createElement('span'),{className:'muted small',textContent:'Nenhuma foto ou vídeo nesta conversa.'}));
    const gallery=$('contact-media-gallery');if(gallery) gallery.replaceChildren(...items.map(tile));
    if($('contact-media-more')) $('contact-media-more').hidden=page>=pages;
    if($('contact-media-status')) $('contact-media-status').textContent=items.length?`${items.length} mídia${items.length===1?'':'s'} carregada${items.length===1?'':'s'}.`:'Nenhuma mídia encontrada.';
  }
  async function load(targetPage=1,append=false) {
    if(!selected || selected.isGroup) return;const token=++generation;controller?.abort();controller=new AbortController();
    if(!append) {items=[];page=1;render();}
    try {const result=await context.api(`/conversation-media?jid=${encodeURIComponent(selected.jid)}&page=${targetPage}`,'GET',undefined,30000,controller.signal);if(token!==generation) return;items=append?[...items,...result.items]:result.items;page=result.page;pages=result.pages;render();}
    catch(error) {if(error.name!=='AbortError' && token===generation) context.notice(error.message);}
  }
  async function openItem(item) {
    try {
      const result=await context.api(`/media?jid=${encodeURIComponent(item.jid)}&id=${encodeURIComponent(item.id)}`,'GET',undefined,100000),raw=result.base64.replace(/^data:[^,]*,/,''),bytes=Uint8Array.from(atob(raw),char=>char.charCodeAt(0)),mimeType=result.mimeType || item.mimeType || 'application/octet-stream';
      viewerUrl=URL.createObjectURL(new Blob([bytes],{type:mimeType}));
      if(item.type==='image') return context.openMedia({url:viewerUrl,fileName:result.fileName || item.fileName || 'foto',previewMime:mimeType},'image');
      const dialog=$('media-viewer'),body=$('media-viewer-content'),video=document.createElement('video');video.src=viewerUrl;video.controls=true;video.autoplay=true;video.playsInline=true;body.replaceChildren(video);$('media-viewer-title').textContent=result.fileName || 'Vídeo da conversa';$('media-download').href=viewerUrl;$('media-download').download=result.fileName || 'video';$('media-zoom').hidden=true;if(!dialog.open) dialog.showModal();
    } catch(error) {context.notice(error.message);}
  }
  async function openAvatar() {if(!selected || selected.isGroup) return;const photo=await globalThis.WhatsAppAvatars?.load?.(selected);if(!photo) return context.notice('Este contato não possui foto de perfil disponível.');context.openMedia({url:photo.url,fileName:`Foto de ${selected.name}`,previewMime:photo.mimeType},'image');}
  function openGallery() {if(!selected || selected.isGroup) return;if(!$('contact-media-dialog').open) $('contact-media-dialog').showModal();render();}
  function openContact() {if(!selected || selected.isGroup) return;context.toggleContact(true);context.showAttendance?.();load(1,false);}
  function onSelect(chat) {selected=chat;generation++;controller?.abort();items=[];page=pages=1;ensurePreview();render();if(chat && !chat.isGroup) load(1,false);}
  function init(value) {context=value;ensurePreview();$('contact-avatar-open')?.addEventListener('click',openAvatar);$('contact-header-info')?.addEventListener('click',openContact);$('contact-media-more')?.addEventListener('click',()=>load(page+1,true));$('media-viewer')?.addEventListener('close',()=>{if(viewerUrl) URL.revokeObjectURL(viewerUrl);viewerUrl=null;});}
  globalThis.WhatsAppContactMedia={init,onSelect};
})();
