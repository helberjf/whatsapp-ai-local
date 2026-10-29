(() => {
  'use strict';
  const $=id=>document.getElementById(id),time=seconds=>Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  let context,recorder=null,stream=null,timer=null,generation=0,recordingJid=null,previewUrl=null,busy=false;
  function previewMime(bytes) {
    const ascii=(start,end)=>String.fromCharCode(...bytes.slice(start,end));
    if(ascii(0,5)==='%PDF-') return 'application/pdf';
    if(bytes[0]===0x89 && ascii(1,4)==='PNG' && bytes[4]===13 && bytes[5]===10 && bytes[6]===26 && bytes[7]===10) return 'image/png';
    if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
    if(['GIF87a','GIF89a'].includes(ascii(0,6))) return 'image/gif';
    if(ascii(0,4)==='RIFF' && ascii(8,12)==='WEBP') return 'image/webp';
    if(ascii(4,8)==='ftyp' && ['avif','avis'].includes(ascii(8,12))) return 'image/avif';
    return null;
  }
  function stopTracks() {for(const track of stream?.getTracks() || []) track.stop();stream=null;clearInterval(timer);timer=null;}
  function clearPreview() {$('voice-preview').pause();$('voice-preview').removeAttribute('src');$('voice-preview').hidden=true;if(previewUrl) URL.revokeObjectURL(previewUrl);previewUrl=null;}
  function refresh() {$('record-audio').disabled=busy || !context.canRecord();$('record-audio').setAttribute('aria-pressed',String(busy));}
  function reset() {
    generation++;busy=false;if(recorder && recorder.state!=='inactive') recorder.stop();recorder=null;stopTracks();clearPreview();recordingJid=null;
    $('voice-recorder').hidden=true;$('voice-recorder').classList.remove('recording');$('voice-stop').hidden=true;refresh();
  }
  function onAttachment(file) {
    reset();if(!file?.type.startsWith('audio/')) return;
    recordingJid=context.getSelected()?.jid;previewUrl=URL.createObjectURL(file);$('voice-preview').src=previewUrl;$('voice-preview').hidden=false;$('voice-status').textContent='Áudio pronto · ouça antes de enviar';$('voice-recorder').hidden=false;refresh();
  }
  async function record() {
    if(busy || !context.canRecord()) {context.notice('Abra uma conversa conectada e remova o anexo atual para gravar.');return;}
    if(!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {context.notice('Este navegador não permite gravar áudio. Use Anexar arquivo → Áudio.');return;}
    reset();busy=true;recordingJid=context.getSelected().jid;const jid=recordingJid,version=generation;refresh();$('voice-recorder').hidden=false;$('voice-status').textContent='Aguardando permissão do microfone…';
    try {
      const microphone=await navigator.mediaDevices.getUserMedia({audio:true});
      if(version!==generation || context.getSelected()?.jid!==jid) {for(const track of microphone.getTracks()) track.stop();return;}
      stream=microphone;const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:64000});const current=recorder,chunks=[];let size=0;
      current.addEventListener('dataavailable',event=>{if(event.data.size) {chunks.push(event.data);size+=event.data.size;}if(size>=9.5*1024*1024 && current.state==='recording') current.stop();});
      current.addEventListener('error',()=>{if(version!==generation) return;reset();context.notice('Não foi possível gravar o áudio. Verifique seu microfone e tente novamente.');});
      current.addEventListener('stop',()=>{
        if(version!==generation) return;stopTracks();recorder=null;busy=false;
        if(context.getSelected()?.jid!==jid) {reset();return;}
        const type=(current.mimeType || mime || 'audio/webm').split(';')[0],blob=new Blob(chunks,{type});
        if(!blob.size || blob.size>10*1024*1024) {reset();context.notice('Áudio vazio ou maior que 10 MB. Faça uma nova gravação.');return;}
        const extension=type.includes('ogg')?'ogg':type.includes('mp4')?'m4a':'webm';context.setAttachment(new File([blob],'audio-'+Date.now()+'.'+extension,{type}));
      });
      const started=Date.now();$('voice-status').textContent='Gravando · 0:00';$('voice-recorder').classList.add('recording');$('voice-stop').hidden=false;current.start(250);
      timer=setInterval(()=>{const seconds=Math.floor((Date.now()-started)/1000);$('voice-status').textContent='Gravando · '+time(seconds);if(seconds>=300 && current.state==='recording') current.stop();},250);
    } catch(error) {
      if(version!==generation) return;reset();context.notice(['NotAllowedError','SecurityError'].includes(error.name)?'Permita o acesso ao microfone neste navegador para gravar áudio.':'Não foi possível acessar o microfone. Verifique se ele está conectado e tente novamente.');
    }
  }
  async function open(media,kind) {
    if((kind==='pdf' && media.previewMime!=='application/pdf') || (kind==='image' && !/^image\/(png|jpeg|gif|webp|avif)$/.test(media.previewMime || ''))) throw new Error('Este formato não pode ser exibido aqui. Use Baixar para abrir o arquivo.');
    const dialog=$('media-viewer'),body=$('media-viewer-content');body.replaceChildren();dialog.classList.remove('zoomed');$('media-zoom').hidden=kind==='pdf';$('media-zoom').setAttribute('aria-pressed','false');$('media-zoom').textContent='Ampliar';
    $('media-viewer-title').textContent=media.fileName || 'Anexo da conversa';$('media-download').href=media.url;$('media-download').download=media.fileName;
    if(!dialog.open) dialog.showModal();
    if(kind==='pdf') {await globalThis.WhatsAppPdf.open(media,body);return;}
    const node=document.createElement('img');node.src=media.url;node.alt=media.fileName || 'Imagem da conversa';body.append(node);
  }
  function init(value) {
    context=value;$('record-audio').addEventListener('click',record);$('voice-stop').addEventListener('click',()=>{if(recorder?.state==='recording') {$('voice-stop').disabled=true;recorder.stop();$('voice-stop').disabled=false;}});
    $('voice-cancel').addEventListener('click',()=>{reset();context.setAttachment(null);});
    context.hooks.select.push(()=>{if(recordingJid && context.getSelected()?.jid!==recordingJid) reset();refresh();});context.hooks.sync.push(refresh);
    context.hooks.view.push(view=>{if(view!=='workspace' && busy) reset();});
    $('media-viewer').addEventListener('close',()=>{globalThis.WhatsAppPdf?.close();$('media-viewer-content').replaceChildren();$('media-download').removeAttribute('href');});
    $('media-zoom').addEventListener('click',()=>{const zoomed=$('media-viewer').classList.toggle('zoomed');$('media-zoom').setAttribute('aria-pressed',String(zoomed));$('media-zoom').textContent=zoomed?'Ajustar':'Ampliar';});
    window.addEventListener('pagehide',reset);refresh();
  }
  globalThis.WhatsAppMedia={init,onAttachment,open,previewMime,isRecording:()=>busy};
})();
