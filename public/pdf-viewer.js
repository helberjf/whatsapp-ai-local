(() => {
  'use strict';
  let library=null,loading=null,documentPdf=null,renderTask=null,version=0;
  function close() {version++;renderTask?.cancel();renderTask=null;loading?.destroy().catch(()=>{});loading=null;documentPdf=null;}
  async function open(media,body) {
    close();const current=version,node=(tag,id,text)=>{const element=document.createElement(tag);if(id) element.id=id;if(text) element.textContent=text;return element;};
    const reader=node('section','pdf-reader'),toolbar=node('div','pdf-toolbar'),previous=node('button','pdf-previous','←'),count=node('span','pdf-page-count','Carregando…'),next=node('button','pdf-next','→'),out=node('button','pdf-zoom-out','−'),zoomLabel=node('span','pdf-zoom-label','100%'),inside=node('button','pdf-zoom-in','+'),stage=node('div','pdf-stage'),canvas=node('canvas','pdf-canvas'),text=node('p','pdf-page-text'),status=node('p','pdf-status','Carregando documento…');
    reader.setAttribute('aria-label','Leitor de PDF');text.className='sr-only';canvas.hidden=true;status.setAttribute('role','status');
    for(const [button,label] of [[previous,'Página anterior'],[next,'Próxima página'],[out,'Diminuir PDF'],[inside,'Ampliar PDF']]) {button.type='button';button.className='icon-button';button.setAttribute('aria-label',label);button.disabled=true;}
    toolbar.append(previous,count,next,out,zoomLabel,inside);stage.append(canvas,text,status);reader.append(toolbar,stage);body.replaceChildren(reader);
    let pageNumber=1,zoom=1,busy=false;
    function controls() {previous.disabled=busy || pageNumber<=1;next.disabled=busy || pageNumber>=documentPdf.numPages;out.disabled=busy || zoom<=.5;inside.disabled=busy || zoom>=2;}
    async function draw() {
      if(busy || current!==version || !documentPdf) return;busy=true;controls();status.hidden=false;status.textContent='Carregando página…';
      try {
        const page=await documentPdf.getPage(pageNumber);if(current!==version) return;
        const original=page.getViewport({scale:1}),ratio=Math.min(window.devicePixelRatio || 1,2),desired=Math.max(200,stage.clientWidth-32)/original.width*zoom;
        const scale=Math.min(desired,Math.sqrt(8_000_000/(original.width*original.height*ratio*ratio))),viewport=page.getViewport({scale});
        canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=Math.ceil(viewport.width)+'px';canvas.style.height=Math.ceil(viewport.height)+'px';
        renderTask=page.render({canvas,canvasContext:canvas.getContext('2d'),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});await renderTask.promise;if(current!==version) return;
        canvas.hidden=false;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Página '+pageNumber+' do documento');count.textContent='Página '+pageNumber+' de '+documentPdf.numPages;zoomLabel.textContent=Math.round(zoom*100)+'%';
        const content=await page.getTextContent();if(current!==version) return;text.textContent=content.items.map(item=>item.str || '').join(' ');status.hidden=true;
      } catch(error) {if(current===version && error.name!=='RenderingCancelledException') {status.textContent='Não foi possível exibir esta página. Use Baixar para abrir no leitor do computador.';status.hidden=false;}}
      finally {if(current===version) {busy=false;renderTask=null;controls();}}
    }
    previous.addEventListener('click',()=>{if(!busy && pageNumber>1) {pageNumber--;draw();}});next.addEventListener('click',()=>{if(!busy && pageNumber<documentPdf.numPages) {pageNumber++;draw();}});
    out.addEventListener('click',()=>{if(!busy) {zoom=Math.max(.5,zoom-.25);draw();}});inside.addEventListener('click',()=>{if(!busy) {zoom=Math.min(2,zoom+.25);draw();}});
    try {
      library=library || await import('/assets/pdfjs/build/pdf.min.mjs');if(current!==version) return;library.GlobalWorkerOptions.workerSrc='/assets/pdfjs/build/pdf.worker.min.mjs';
      loading=library.getDocument({data:new Uint8Array(media.bytes),isEvalSupported:false,enableXfa:false,cMapUrl:'/assets/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/pdfjs/standard_fonts/',wasmUrl:'/assets/pdfjs/wasm/',iccUrl:'/assets/pdfjs/iccs/'});
      loading.onPassword=()=>{if(current===version) {status.textContent='PDF protegido por senha. Use Baixar para abrir no seu leitor.';loading.destroy().catch(()=>{});}};
      const loaded=await loading.promise;if(current!==version) {loaded.destroy().catch(()=>{});return;}documentPdf=loaded;await draw();
    } catch {if(current===version && !status.textContent.includes('senha')) status.textContent='Não foi possível exibir este PDF. Use Baixar para abrir no leitor do computador.';}
  }
  globalThis.WhatsAppPdf={open,close};
})();
