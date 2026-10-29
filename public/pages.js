(() => {
  'use strict';
  const C=globalThis.WhatsAppCentral;if(!C) return;
  const {$,el,api,notice,dateTime,initials,phoneLabel}=C;
  const statuses={open:'Em aberto',pending:'Pendente',closed:'Concluído'};
  let docs=[],products=[],ai=null,view='workspace',editing=null,candidates=[];
  const thumbs=new Map();
  const bytes=size=>size<1024?size+' B':size<1048576?(size/1024).toFixed(0)+' KB':(size/1048576).toFixed(1)+' MB';
  const money=value=>value===null || value===undefined?'Sob consulta':new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
  const normalize=text=>String(text || '').normalize('NFD').replace(/[̀-ͯ]/g,'').toLocaleLowerCase('pt-BR');
  const fileBase64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(file);});
  const toBytes=base64=>Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
  const guard=fn=>async(...args)=>{try {await fn(...args);}catch(error) {notice(error.message);}};
  const icon=name=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#i-'+name);svg.append(use);return svg;};
  function iconButton(name,label,onClick,className='icon-button') {const button=el('button',className);button.type='button';button.title=label;button.setAttribute('aria-label',label);button.append(icon(name));button.addEventListener('click',guard(onClick));return button;}
  function textButton(label,className,onClick,iconName) {const button=el('button',className);button.type='button';if(iconName) button.append(icon(iconName));button.append(label);button.addEventListener('click',guard(onClick));return button;}
  const empty=(text)=>el('p','empty-note',text);

  // ---------- Contadores e status ----------
  function renderCounters() {
    $('metric-docs').textContent=docs.length;$('metric-products').textContent=products.length;
    $('status-kb').textContent=docs.length?docs.length+(docs.length===1?' documento':' documentos'):'Vazia';$('dot-kb').classList.toggle('on',docs.length>0);
    $('status-products').textContent=products.length?String(products.length):'Nenhum';$('dot-products').classList.toggle('on',products.length>0);
    const on=Boolean(ai?.configured);
    $('status-ai').textContent=on?'Configurada':'Não configurada';$('dot-ai').classList.toggle('on',on);
    $('ai-card-model').textContent=on?ai.model:'IA não configurada';$('ai-card-label').textContent=on?'Ativa':'Inativa';$('ai-card-mode').textContent=on?'Assistido':'Manual';
    $('ai-card-state').classList.toggle('on',on);
  }
  async function refreshKb() {const result=await api('/kb');docs=result.documents;renderKb();renderCounters();}
  async function refreshProducts() {products=(await api('/products')).products;renderProducts();renderPanelProducts();renderCounters();}
  async function refreshAi() {ai=await api('/ai');renderAi();renderCounters();}

  // ---------- Base de conhecimento ----------
  function renderKb() {
    const rows=document.createDocumentFragment();
    for(const doc of docs) {
      const row=el('tr'),name=el('td','doc-name');name.append(icon('doc'),el('span','',doc.name));if(doc.source==='pasta') name.append(el('span','badge','pasta'));
      const actions=el('td','row-actions');actions.append(iconButton('eye','Ver conteúdo',()=>viewDoc(doc)),iconButton('trash','Excluir documento',()=>removeDoc(doc)));
      row.append(name,el('td','',doc.type.toUpperCase()),el('td','',bytes(doc.size)),el('td','',dateTime(doc.createdAt)),el('td','',String(doc.chunks)),actions);rows.append(row);
    }
    if(!docs.length) {const row=el('tr'),cell=el('td','empty-cell','Nenhum documento ainda. Envie um catálogo, uma tabela de preços ou as políticas da empresa.');cell.colSpan=7;row.append(cell);rows.append(row);}
    $('kb-body').replaceChildren(rows);
  }
  async function viewDoc(doc) {
    const detail=await api('/kb/doc?id='+doc.id);
    $('doc-title').textContent=detail.name;$('doc-text').textContent=detail.text;$('doc-note').textContent=detail.truncated?`Mostrando o início do documento (${detail.chars} caracteres no total).`:`${detail.chars} caracteres.`;$('doc-dialog').showModal();
  }
  async function removeDoc(doc) {
    if(!confirm(`Excluir "${doc.name}" da base? Produtos já cadastrados não são afetados.`)) return;
    await api('/kb?id='+doc.id,'DELETE');await refreshKb();notice('Documento excluído.',true);
  }
  async function uploadFiles(files) {
    const list=[...files],failures=[];let done=0;
    for(const file of list) {
      $('kb-status').textContent=`Enviando ${++done} de ${list.length}: ${file.name}…`;
      try {
        if(file.size>10*1024*1024) throw new Error('passa de 10 MB.');
        await api('/kb','POST',{name:file.name,base64:await fileBase64(file)},undefined,60000);
      } catch(error) {failures.push(`${file.name}: ${error.message}`);}
    }
    $('kb-status').textContent=failures.length?'Não foi possível enviar: '+failures.join(' · '):list.length?`${list.length} documento(s) adicionado(s).`:'';
    if(failures.length) notice(failures[0]);
    await refreshKb();
  }
  $('kb-file').addEventListener('change',guard(async()=>{const files=[...$('kb-file').files];$('kb-file').value='';if(files.length) await uploadFiles(files);}));
  $('kb-drop').addEventListener('click',()=>$('kb-file').click());
  $('kb-pick').addEventListener('click',()=>$('kb-file').click());
  $('kb-sync').addEventListener('click',guard(async()=>{
    $('kb-sync').disabled=true;
    try {
      const result=await api('/kb/sync','POST',{});await refreshKb();
      $('kb-status').textContent=result.folder?`Pasta sincronizada: ${result.added} novo(s), ${result.updated} atualizado(s), ${result.unchanged} sem mudança.`+(result.failed.length?' Falhas: '+result.failed.join(' · '):''):'Nenhuma pasta de base configurada.';
    } finally {$('kb-sync').disabled=false;}
  }));
  $('kb-drop').addEventListener('keydown',event=>{if(event.key==='Enter' || event.key===' ') {event.preventDefault();$('kb-file').click();}});
  $('kb-drop').addEventListener('dragover',event=>{event.preventDefault();$('kb-drop').classList.toggle('over',true);});
  $('kb-drop').addEventListener('dragleave',()=>$('kb-drop').classList.toggle('over',false));
  $('kb-drop').addEventListener('drop',guard(async event=>{event.preventDefault();$('kb-drop').classList.toggle('over',false);if(event.dataTransfer?.files.length) await uploadFiles(event.dataTransfer.files);}));
  $('kb-paste').addEventListener('click',()=>{$('paste-error').textContent='';$('paste-dialog').showModal();});
  $('paste-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {await api('/kb','POST',{name:$('paste-name').value,text:$('paste-text').value});$('paste-name').value='';$('paste-text').value='';$('paste-dialog').close();await refreshKb();notice('Texto adicionado à base.',true);}
    catch(error) {$('paste-error').textContent=error.message;}finally {button.disabled=false;}
  });

  // Resposta da base: texto, trechos usados e (opcional) botão para levar ao editor da conversa.
  function renderAnswer(container,result,insertable) {
    const fragment=document.createDocumentFragment();
    if(result.answer) {
      fragment.append(el('p','answer-text',result.answer));
      if(insertable && C.selected()) fragment.append(textButton('Inserir no editor','button secondary full',()=>{C.insertDraft(result.answer);notice('Resposta inserida no editor. Revise antes de enviar.',true);},'edit'));
    }
    if(result.note) fragment.append(el('p','muted',result.note));
    if(!result.sources.length) fragment.append(el('p','muted',result.usedAi===false && !result.answer?'Nenhum trecho relevante encontrado.':'Nenhum trecho da base foi usado.'));
    else {
      fragment.append(el('h3','sources-title','Trechos usados'));
      for(const source of result.sources) {
        const details=el('details','source'),summary=el('summary','',`${source.doc} · ${Math.round(source.relevance*100)}% relevante`);
        details.append(summary,el('p','source-text',source.text));fragment.append(details);
      }
    }
    if(result.ms!==undefined) fragment.append(el('small','muted',`Consulta em ${(result.ms/1000).toFixed(1)} s`));
    container.replaceChildren(fragment);
  }
  async function ask(textarea,container,insertable,button) {
    container.replaceChildren(el('p','muted','Consultando a base…'));button.disabled=true;
    try {renderAnswer(container,await api('/kb/ask','POST',{question:textarea.value},180000),insertable);}
    catch(error) {container.replaceChildren(el('p','form-error',error.message));}finally {button.disabled=false;}
  }
  $('kb-ask-form').addEventListener('submit',event=>{event.preventDefault();ask($('kb-question'),$('kb-answer'),false,event.submitter);});
  $('assistant-form').addEventListener('submit',event=>{event.preventDefault();ask($('assistant-question'),$('assistant-answer'),true,event.submitter);});

  // ---------- Produtos e serviços (padrão da loja) ----------
  let activeCategory='';
  const imageUrl=async image=>{
    if(!thumbs.has(image.id)) {const data=await api('/product-image?id='+image.id);thumbs.set(image.id,URL.createObjectURL(new Blob([toBytes(data.base64)],{type:data.mimeType})));}
    return thumbs.get(image.id);
  };
  async function thumbnail(product,holder) {
    if(!product.images?.length) return;
    const img=el('img');img.src=await imageUrl(product.images[0]);img.alt=product.name;holder.replaceChildren(img);
  }
  // Sem conversa aberta, deixa escolher o destino antes de inserir a ficha no editor.
  function chooseChat() {
    return new Promise(resolve=>{
      let chosen=null;
      const render=()=>{
        const search=normalize($('chat-pick-search').value),fragment=document.createDocumentFragment();
        for(const chat of C.chats().filter(item=>!search || normalize(item.name+' '+item.jid).includes(search))) {
          const button=el('button','template-shortcut');button.type='button';button.append(el('strong','',chat.name),el('small','',chat.jid.endsWith('@lid')?'Identificador privado':phoneLabel(chat.jid.split('@')[0])));
          button.addEventListener('click',()=>{chosen=chat;$('chat-pick-dialog').close();});fragment.append(button);
        }
        if(!fragment.children.length) fragment.append(empty(C.chats().length?'Nenhuma conversa encontrada.':'Conecte o WhatsApp para ver as conversas.'));
        $('chat-pick-list').replaceChildren(fragment);
      };
      $('chat-pick-search').value='';$('chat-pick-search').oninput=render;
      $('chat-pick-dialog').onclose=()=>resolve(chosen);
      render();$('chat-pick-dialog').showModal();
    });
  }
  async function useProduct(product) {
    if(!C.selected()) {const chat=await chooseChat();if(!chat) return;await C.openChat(chat);}
    let file=null;
    if(product.images?.length) {const image=await api('/product-image?id='+product.images[0].id);file=new File([toBytes(image.base64)],'foto.'+(image.mimeType==='image/jpeg'?'jpg':image.mimeType.split('/')[1]),{type:image.mimeType});}
    C.showView('workspace','nav-conversations');C.insertDraft(product.message,file);
    notice('Ficha inserida no editor. Revise e envie.',true);
  }
  const badge=(text,className)=>el('span','pbadge '+className,text);
  function renderCategories() {
    const names=[...new Set(products.map(product=>product.category))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
    if(activeCategory && !names.includes(activeCategory)) activeCategory='';
    const fragment=document.createDocumentFragment();
    for(const name of ['',...names]) {
      const count=name?products.filter(product=>product.category===name).length:products.length;
      const chip=el('button','chip-button'+(name===activeCategory?' active':''),name?`${name} (${count})`:`Todos (${count})`);chip.type='button';chip.setAttribute('aria-pressed',String(name===activeCategory));
      chip.addEventListener('click',()=>{activeCategory=name;renderProducts();});fragment.append(chip);
    }
    $('products-categories').replaceChildren(fragment);
    const options=document.createDocumentFragment();for(const name of names) {const option=el('option');option.value=name;options.append(option);}
    $('product-categories').replaceChildren(options);
  }
  const visibleProducts=()=>{
    const search=normalize($('products-search').value),kind=$('products-kind').value,hide=$('products-hide-inactive').checked;
    return products.filter(product=>(!activeCategory || product.category===activeCategory) && (!kind || product.kind===kind) && (!hide || product.active) && (!search || normalize(`${product.name} ${product.sku} ${product.category} ${product.description}`).includes(search)));
  };
  function renderProducts() {
    renderCategories();
    const list=visibleProducts(),fragment=document.createDocumentFragment();
    $('products-count').textContent=products.length?`${list.length} de ${products.length} ${products.length===1?'item':'itens'}`:'';
    for(const product of list) {
      const card=el('article','product-card'+(product.active?'':' inactive')),photo=el('div','product-photo');photo.append(icon(product.kind==='servico'?'sparkle':'box'));
      thumbnail(product,photo).catch(()=>{});
      const flags=el('div','photo-flags');
      if(product.discountPercent) flags.append(badge(product.discountPercent+'% OFF','off'));
      if(product.kind==='servico') flags.append(badge('Serviço','service'));
      if(!product.active) flags.append(badge('Inativo','muted'));
      photo.append(flags);
      const body=el('div','product-body');
      body.append(el('small','product-category',product.category),el('strong','',product.name));
      const price=el('div','price-row');
      if(product.price===null) price.append(el('span','product-price consult','Sob consulta'));
      else {
        if(product.discountPercent) price.append(el('s','old-price',money(product.price)));
        price.append(el('span','product-price',money(product.finalPrice)));
      }
      body.append(price);
      const tags=el('div','tag-row');
      if(product.freeShipping) tags.append(badge('Frete grátis','ship'));
      if(product.stock!==null) tags.append(badge(product.stock>0?`Estoque: ${product.stock}`:'Esgotado',product.stock>0?'stock':'out'));
      if(product.warranty) tags.append(badge('Garantia '+product.warranty,'stock'));
      if(tags.children.length) body.append(tags);
      if(product.sku) body.append(el('small','muted','Cód. '+product.sku));
      if(product.description) body.append(el('p','product-description',product.description));
      const actions=el('div','product-actions');
      actions.append(textButton('Usar na conversa','button primary',()=>useProduct(product),'send'),iconButton('copy','Copiar mensagem',async()=>{await navigator.clipboard.writeText(product.message);notice('Mensagem copiada.',true);}),iconButton('edit','Editar',()=>openProduct(product)),iconButton('trash','Excluir',()=>removeProduct(product)));
      card.append(photo,body,actions);fragment.append(card);
    }
    if(!list.length) fragment.append(empty(products.length?'Nenhum item corresponde aos filtros.':'Nenhum item ainda. Cadastre um ou importe da base de conhecimento com IA.'));
    $('products-grid').replaceChildren(fragment);
  }
  function renderPanelProducts() {
    const search=normalize($('panel-products-search').value),fragment=document.createDocumentFragment();
    const list=products.filter(product=>product.active && (!search || normalize(`${product.name} ${product.sku} ${product.category}`).includes(search)));
    $('panel-products-count').textContent=products.filter(product=>product.active).length;
    for(const product of list) {
      const button=el('button','template-shortcut');button.type='button';button.title=C.selected()?'Inserir no editor':'Selecione uma conversa para usar este item';button.disabled=!C.selected();
      button.append(el('strong','',product.name),el('small','',(product.price===null?'Sob consulta':money(product.finalPrice))+' · '+product.category));button.addEventListener('click',guard(()=>useProduct(product)));fragment.append(button);
    }
    if(!list.length) fragment.append(empty(products.length?'Nada encontrado.':'Cadastre itens na página Produtos.'));
    $('panel-products').replaceChildren(fragment);
  }

  // Fotos do formulário: existentes (já salvas) e novas (ainda no navegador).
  let photoDraft={existing:[],added:[],removed:[]};
  function renderPhotos() {
    const fragment=document.createDocumentFragment();
    const add=(src,label,onRemove)=>{
      const item=el('div','photo-item'),img=el('img');img.alt=label;if(src) img.src=src;
      const remove=el('button','photo-remove','×');remove.type='button';remove.title='Remover foto';remove.setAttribute('aria-label','Remover foto');remove.addEventListener('click',onRemove);
      item.append(img,remove);fragment.append(item);return img;
    };
    for(const image of photoDraft.existing) {const img=add('', 'Foto salva',()=>{photoDraft.existing=photoDraft.existing.filter(item=>item!==image);photoDraft.removed.push(image.id);renderPhotos();});imageUrl(image).then(url=>{img.src=url;}).catch(()=>{});}
    for(const item of photoDraft.added) add(item.url,item.file.name,()=>{photoDraft.added=photoDraft.added.filter(other=>other!==item);URL.revokeObjectURL(item.url);renderPhotos();});
    $('product-photos').replaceChildren(fragment);
    $('product-add-photo').disabled=photoDraft.existing.length+photoDraft.added.length>=5;
  }
  $('product-add-photo').addEventListener('click',()=>$('product-images').click());
  $('product-images').addEventListener('change',()=>{
    const files=[...$('product-images').files];$('product-images').value='';$('product-error').textContent='';
    for(const file of files) {
      if(photoDraft.existing.length+photoDraft.added.length>=5) {$('product-error').textContent='Use até 5 fotos.';break;}
      if(!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>3*1024*1024) {$('product-error').textContent=`"${file.name}": use PNG, JPG ou WEBP de até 3 MB.`;continue;}
      photoDraft.added.push({file,url:URL.createObjectURL(file)});
    }
    renderPhotos();
  });
  function openProduct(product=null) {
    editing=product;$('product-title').textContent=product?'Editar item':'Novo item';$('product-error').textContent='';
    const value=(id,data)=>{$(id).value=data===null || data===undefined?'':String(data);};
    value('product-name',product?.name);$('product-kind').value=product?.kind || 'produto';value('product-description',product?.description);value('product-category',product?.category);value('product-sku',product?.sku);
    value('product-price',product?.price!=null?String(product.price).replace('.',','):'');value('product-stock',product?.stock);value('product-discount',product?.discountPercent || '');value('product-warranty',product?.warranty);
    $('product-active').checked=product?product.active:true;$('product-free-shipping').checked=Boolean(product?.freeShipping);
    value('product-weight',product?.weightGrams);value('product-height',product?.heightCm);value('product-width',product?.widthCm);value('product-length',product?.lengthCm);
    photoDraft={existing:[...(product?.images || [])],added:[],removed:[]};renderPhotos();
    $('product-dialog').showModal();
  }
  $('product-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter || $('product-form').querySelector('button[type=submit]');button.disabled=true;
    try {
      const input={name:$('product-name').value,kind:$('product-kind').value,description:$('product-description').value,category:$('product-category').value,sku:$('product-sku').value,price:$('product-price').value,stock:$('product-stock').value,discountPercent:$('product-discount').value,warranty:$('product-warranty').value,active:$('product-active').checked,freeShipping:$('product-free-shipping').checked,weightGrams:$('product-weight').value,heightCm:$('product-height').value,widthCm:$('product-width').value,lengthCm:$('product-length').value};
      input.images=await Promise.all(photoDraft.added.map(async item=>({base64:await fileBase64(item.file),mimeType:item.file.type})));
      if(editing) {input.removeImages=photoDraft.removed;await api('/products?id='+editing.id,'PATCH',input,undefined,90000);}
      else await api('/products','POST',input,undefined,90000);
      $('product-dialog').close();await refreshProducts();notice('Item salvo.',true);
    } catch(error) {$('product-error').textContent=error.message;}finally {button.disabled=false;}
  });
  async function removeProduct(product) {
    if(!confirm(`Excluir "${product.name}"?`)) return;
    await api('/products?id='+product.id,'DELETE');await refreshProducts();notice('Item excluído.',true);
  }
  $('product-new').addEventListener('click',()=>openProduct());
  $('products-search').addEventListener('input',renderProducts);
  $('products-kind').addEventListener('change',renderProducts);
  $('products-hide-inactive').addEventListener('change',renderProducts);
  $('panel-products-search').addEventListener('input',renderPanelProducts);
  $('panel-products-manage').addEventListener('click',()=>C.showView('page-products','nav-products'));

  // ---------- Importar produtos da base com IA ----------
  function openImport() {
    $('import-review').hidden=true;$('import-status').textContent='';candidates=[];
    const fragment=document.createDocumentFragment();
    for(const doc of docs) {const label=el('label','check'),box=el('input');box.type='checkbox';box.checked=true;box.value=doc.id;label.append(box,' '+doc.name);fragment.append(label);}
    if(!docs.length) fragment.append(empty('A base está vazia. Envie um catálogo em Base de Conhecimento primeiro.'));
    $('import-docs').replaceChildren(fragment);
    const blocked=!docs.length || !ai?.configured;
    $('import-run').disabled=blocked;
    if(docs.length && !ai?.configured) $('import-status').textContent='Configure o Assistente de IA antes de importar.';
    $('import-dialog').showModal();
  }
  $('product-import').addEventListener('click',guard(async()=>{await Promise.all([refreshKb(),refreshAi()]);openImport();}));
  $('import-run').addEventListener('click',async()=>{
    const ids=[...$('import-docs').children].filter(label=>label.firstElementChild?.checked).map(label=>label.firstElementChild.value);
    if(!ids.length) {$('import-status').textContent='Escolha ao menos um documento.';return;}
    $('import-run').disabled=true;$('import-status').textContent='A IA está lendo os documentos… isso pode levar alguns instantes.';$('import-review').hidden=true;
    try {
      const result=await api('/products/extract','POST',{documentIds:ids},180000);candidates=result.candidates;
      $('import-status').textContent=candidates.length?(result.truncated?'Documento longo: analisei só o início. ':'')+'Revise a lista abaixo.':'A IA não encontrou produtos nesses documentos.';
      renderCandidates();
    } catch(error) {$('import-status').textContent=error.message;}finally {$('import-run').disabled=false;}
  });
  function renderCandidates() {
    const fragment=document.createDocumentFragment();
    for(const candidate of candidates) {
      const row=el('tr'),pick=el('input');pick.type='checkbox';pick.checked=!candidate.existingId;pick.setAttribute('aria-label','Importar '+candidate.name);
      const name=el('input','cell-input');name.value=candidate.name;name.maxLength=120;
      const price=el('input','cell-input narrow');price.value=candidate.price!==null?String(candidate.price).replace('.',','):'';price.inputMode='decimal';
      const category=el('input','cell-input');category.value=candidate.category;category.maxLength=60;category.setAttribute('aria-label','Categoria de '+candidate.name);
      const source=el('td','',candidate.source);if(candidate.existingId) source.append(el('span','badge','Já cadastrado: atualiza'));
      const first=el('td'),second=el('td'),third=el('td'),fourth=el('td');first.append(pick);second.append(name);third.append(category);fourth.append(price);
      row.append(first,second,third,fourth,source);row.collect=()=>pick.checked?{...candidate,name:name.value,price:price.value,category:category.value}:null;fragment.append(row);
    }
    $('import-body').replaceChildren(fragment);$('import-review').hidden=!candidates.length;
    $('import-summary').textContent=`${candidates.length} produto(s) encontrado(s)`;
  }
  $('import-confirm').addEventListener('click',async()=>{
    const items=[...$('import-body').children].map(row=>row.collect()).filter(Boolean);
    if(!items.length) {$('import-status').textContent='Marque ao menos um produto.';return;}
    $('import-confirm').disabled=true;
    try {
      const result=await api('/products/bulk','POST',{items});$('import-dialog').close();await refreshProducts();
      C.showView('page-products','nav-products');notice(`${result.created} produto(s) criado(s) e ${result.updated} atualizado(s).`,true);
    } catch(error) {$('import-status').textContent=error.message;}finally {$('import-confirm').disabled=false;}
  });

  // ---------- Assistente de IA (configuração) ----------
  let lastDefaultModel='',localBusy=false,localCheck=0;
  function showLocalState(state) {
    const cpu=$('ai-local-cpu').checked,ready=state.running && state.loaded && (!cpu || state.executionMode==='cpu'),missing=state.running && !state.modelInstalled;
    const selected=ai?.provider==='ollama' && ai.model===state.model && (ai.ollamaNumGpu===0)===cpu && (!ai.baseUrl || /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):11434(?:\/v1)?\/?$/.test(ai.baseUrl));
    $('ai-local-state').textContent=ready?'Pronta para usar':missing?'Modelo não instalado':state.running?'Ollama ligado':'Desligada';
    $('ai-local-state').dataset.ready=String(ready);
    $('ai-local-description').textContent=ready?`${state.model} carregado ${state.executionMode==='cpu'?'na CPU. As respostas podem ser mais lentas':'neste computador'}. ${selected?'A IA local está pronta para responder.':'Clique em Usar IA local para selecionar este modelo no assistente.'}`:missing?`Instale o modelo ${state.model} no Ollama ou escolha um dos modelos disponíveis: ${state.models.join(', ') || 'nenhum'}.`:state.running?`Clique para carregar ${state.model} e deixá-lo pronto para usar.`:state.installed?'Ollama instalado. Clique para iniciar em segundo plano e carregar o modelo.':'Instale o Ollama neste computador e volte aqui para ligar a IA local.';
    $('ai-local-start').disabled=localBusy || (ready && selected);$('ai-local-start').textContent=ready?(selected?'IA local pronta':'Usar IA local'):'Ligar IA local';
  }
  async function refreshLocalAi() {
    $('ai-local-controls').hidden=$('ai-provider').value!=='ollama';if($('ai-local-controls').hidden || localBusy) return;
    const version=++localCheck,model=$('ai-model').value.trim() || ai.providers.ollama.model,baseUrl=$('ai-base').value.trim();$('ai-local-state').textContent='Verificando…';$('ai-local-refresh').disabled=true;
    try {const state=await api('/ai/local?model='+encodeURIComponent(model)+'&baseUrl='+encodeURIComponent(baseUrl)+'&device='+($('ai-local-cpu').checked?'cpu':'auto'));if(version===localCheck && !localBusy) showLocalState(state);}
    catch(error) {if(version===localCheck && !localBusy) {$('ai-local-state').textContent='Verifique a configuração';$('ai-local-description').textContent=error.message;$('ai-local-start').disabled=false;}}
    finally {if(version===localCheck && !localBusy) $('ai-local-refresh').disabled=false;}
  }
  $('ai-local-refresh').addEventListener('click',refreshLocalAi);
  $('ai-local-start').addEventListener('click',async()=>{
    if(localBusy) return;localBusy=true;localCheck++;const fields=['ai-provider','ai-model','ai-base','ai-key','ai-save','ai-test','ai-clear','ai-local-start','ai-local-refresh','ai-local-cpu'];for(const id of fields) $(id).disabled=true;
    $('ai-local-state').textContent='Preparando…';$('ai-local-state').dataset.ready='false';$('ai-local-start').textContent='Ligando IA local…';$('ai-local-description').textContent='Iniciando o Ollama e carregando o modelo. A primeira carga pode demorar um pouco.';
    let result;
    try {result=await api('/ai/local/start','POST',{model:$('ai-model').value.trim() || ai.providers.ollama.model,baseUrl:$('ai-base').value.trim(),device:$('ai-local-cpu').checked?'cpu':'auto'},180000);ai=result.config;renderAi();renderCounters();$('ai-status').textContent='IA local pronta. Configuração do Ollama salva.';}
    catch(error) {$('ai-local-state').textContent='Não foi possível ligar';$('ai-local-description').textContent=error.message;}
    finally {localBusy=false;for(const id of fields) $(id).disabled=false;if(result) showLocalState(result);else $('ai-local-start').textContent='Tentar ligar IA local';}
  });
  for(const id of ['ai-model','ai-base','ai-local-cpu']) $(id).addEventListener('input',()=>{if(!localBusy) {localCheck++;$('ai-local-refresh').disabled=false;$('ai-local-start').disabled=false;$('ai-local-start').textContent='Ligar IA local';$('ai-local-state').textContent='Configuração alterada';$('ai-local-state').dataset.ready='false';}});
  function renderAi() {
    if(!ai) return;
    const options=document.createDocumentFragment();
    for(const [id,item] of Object.entries(ai.providers)) {const option=el('option','',item.label);option.value=id;options.append(option);}
    $('ai-provider').replaceChildren(options);$('ai-provider').value=ai.provider;
    $('ai-model').value=ai.model;$('ai-base').value=ai.baseUrl;$('ai-key').value='';$('ai-local-cpu').checked=ai.ollamaNumGpu===0;lastDefaultModel=ai.providers[ai.provider].model;
    syncProviderHints();
    $('ai-key-hint').textContent=ai.hasKey?'Uma chave está salva neste computador. Cole outra para trocar.':'A chave fica só neste computador e nunca volta para a tela.';
    $('ai-clear').hidden=!ai.hasKey;
  }
  function syncProviderHints() {
    const item=ai.providers[$('ai-provider').value];
    $('ai-model').placeholder=item.model || 'nome do modelo';$('ai-base').placeholder=item.baseUrl || 'https://seu-servidor/v1';
    $('ai-key').placeholder=item.key?'Cole a chave para salvar ou trocar':'Opcional para este provedor';
    refreshLocalAi();
  }
  $('ai-provider').addEventListener('change',()=>{
    const item=ai.providers[$('ai-provider').value];
    if(!$('ai-model').value || $('ai-model').value===lastDefaultModel) $('ai-model').value=item.model;
    lastDefaultModel=item.model;syncProviderHints();
  });
  const aiPayload=()=>({provider:$('ai-provider').value,model:$('ai-model').value,baseUrl:$('ai-base').value,...($('ai-key').value.trim()?{apiKey:$('ai-key').value.trim()}:{})});
  $('ai-form').addEventListener('submit',async event=>{
    event.preventDefault();$('ai-status').textContent='';
    try {ai=await api('/ai','PUT',aiPayload());renderAi();renderCounters();$('ai-status').textContent='Configuração salva.';}
    catch(error) {$('ai-status').textContent=error.message;}
  });
  $('ai-test').addEventListener('click',async()=>{
    $('ai-test').disabled=true;$('ai-status').textContent='Testando…';
    try {ai=await api('/ai','PUT',aiPayload());renderAi();renderCounters();const result=await api('/ai/test','POST',{},undefined,120000);$('ai-status').textContent=`Conexão funcionando. Resposta do modelo: "${result.reply}".`;}
    catch(error) {$('ai-status').textContent=error.message;}finally {$('ai-test').disabled=false;}
  });
  $('ai-clear').addEventListener('click',async()=>{
    if(!confirm('Remover a chave de API salva neste computador?')) return;
    try {ai=await api('/ai','PUT',{...aiPayload(),clearKey:true});renderAi();renderCounters();$('ai-status').textContent='Chave removida.';}catch(error) {$('ai-status').textContent=error.message;}
  });

  // ---------- Contatos (CRM) ----------
  function listedContacts() {
    const search=normalize($('contacts-search').value),status=$('contacts-status').value;
    return C.chats().filter(chat=>(!status || chat.status===status) && (!search || normalize(`${chat.name} ${chat.jid} ${(chat.labels || []).join(' ')}`).includes(search)));
  }
  function renderContacts() {
    const fragment=document.createDocumentFragment();
    const list=listedContacts();
    for(const chat of list) {
      const row=el('tr','clickable'),who=el('td','doc-name'),open=el('button','link-button',chat.name);open.type='button';open.addEventListener('click',()=>C.openChat(chat));
      who.append(el('span','avatar',initials(chat.name)),open);
      const labels=el('td','labels');for(const label of chat.labels || []) labels.append(el('span','chip',label));
      const phone=chat.jid.endsWith('@lid')?'Identificador privado':phoneLabel(chat.jid.split('@')[0]);
      const mode=el('select','cell-input narrow');mode.setAttribute('aria-label','IA para '+chat.name);for(const [value,text] of Object.entries(MODE_LABEL)) {const option=el('option','',text);option.value=value;mode.append(option);}mode.value=chat.aiMode || 'off';
      mode.addEventListener('change',guard(async()=>{try {await setMode(chat,mode.value);notice('IA de '+chat.name+': '+MODE_LABEL[mode.value]+'.',true);}catch(error) {mode.value=chat.aiMode || 'off';throw error;}}));
      const modeCell=el('td');modeCell.append(mode);
      row.append(who,el('td','',phone),labels,el('td','',statuses[chat.status] || statuses.open),modeCell,el('td','',String((chat.notes || []).length)),el('td','',chat.lastMessage?.text || (chat.lastMessage?.type && chat.lastMessage.type!=='text'?'Anexo':'—')));
      fragment.append(row);
    }
    if(!list.length) {const row=el('tr'),cell=el('td','empty-cell',C.chats().length?'Nenhum contato corresponde aos filtros.':'Os contatos aparecem aqui quando o WhatsApp sincroniza as conversas.');cell.colSpan=6;row.append(cell);fragment.append(row);}
    $('contacts-body').replaceChildren(fragment);
  }
  $('contacts-search').addEventListener('input',renderContacts);$('contacts-status').addEventListener('change',renderContacts);

  // ---------- Busca global ----------
  function renderSearch() {
    const query=normalize($('global-search').value.trim()),box=$('global-results');
    if(query.length<2) {box.hidden=true;box.replaceChildren();return;}
    const fragment=document.createDocumentFragment();
    const group=(title,items)=>{if(!items.length) return;fragment.append(el('h4','',title));for(const item of items) {const button=el('button','result');button.type='button';button.append(el('strong','',item.title),el('small','',item.detail));button.addEventListener('click',()=>{box.hidden=true;$('global-search').value='';item.open();});fragment.append(button);}};
    group('Conversas',C.chats().filter(chat=>normalize(`${chat.name} ${chat.jid} ${(chat.labels || []).join(' ')}`).includes(query)).slice(0,5).map(chat=>({title:chat.name,detail:chat.jid.endsWith('@lid')?'Identificador privado':phoneLabel(chat.jid.split('@')[0]),open:()=>C.openChat(chat)})));
    group('Produtos',products.filter(product=>normalize(`${product.name} ${product.sku} ${product.category}`).includes(query)).slice(0,5).map(product=>({title:product.name,detail:money(product.price),open:()=>{$('products-search').value=product.name;C.showView('page-products','nav-products');}})));
    group('Documentos',docs.filter(doc=>normalize(doc.name).includes(query)).slice(0,5).map(doc=>({title:doc.name,detail:bytes(doc.size),open:()=>{C.showView('page-knowledge','nav-knowledge');guard(viewDoc)(doc);}})));
    if(!fragment.children.length) fragment.append(el('p','empty-note','Nada encontrado.'));
    box.replaceChildren(fragment);box.hidden=false;
  }
  $('global-search').addEventListener('input',renderSearch);
  $('global-search').addEventListener('keydown',event=>{if(event.key==='Escape') {$('global-results').hidden=true;}});
  document.addEventListener('click',event=>{if(!event.target.closest?.('.global-search')) $('global-results').hidden=true;});

  // ---------- Atendimento automático, regras e classificação de contatos ----------
  let assistant=null,rulesDraft=[],audienceSelect=null,audienceSave=null;
  const MODE_LABEL={off:'Desligada',draft:'Rascunho',auto:'Automática'};
  const ACTION_LABEL={draft:'Rascunho preparado',sent:'Resposta enviada',handoff:'Chamou atendente',error:'Erro'};
  const AUDIENCE_LABEL={classified:'Apenas contatos classificados',all:'Todos os contatos',new:'Apenas conversas novas'};
  const AUDIENCE_HINT={
    classified:'A IA prepara rascunhos ou responde conforme a classificação de cada contato. Respostas automáticas exigem a chave geral ligada.',
    all:'Com a chave geral ligada, a IA atende todos os contatos individuais, inclusive quem já conversou com você. Contatos em “Desligada”, em rascunho ou com automações pausadas mantêm sua escolha.',
    new:'Com a chave geral ligada, a IA atende conversas iniciadas depois da ativação, sem histórico anterior. Contatos admitidos continuam atendidos nas próximas mensagens, sem histórico anterior de mensagens recebidas ou enviadas. Estar salvo na agenda não define se um contato é novo. Contatos em “Desligada”, em rascunho ou com automações pausadas mantêm sua escolha.'
  };
  function renderAudienceHint() {if(audienceSelect) $('assistant-audience-hint').textContent=AUDIENCE_HINT[audienceSelect.value] || AUDIENCE_HINT.classified;}
  function buildAudienceControls() {
    const anchor=$('assistant-summary');if(!anchor?.parentNode) return;
    const box=el('div','assistant-audience-controls'),label=el('label','field','Quem a IA pode atender?');
    audienceSelect=el('select');audienceSelect.id='assistant-audience';audienceSelect.setAttribute('aria-describedby','assistant-audience-hint');
    for(const [value,text] of Object.entries(AUDIENCE_LABEL)) {const option=el('option','',text);option.value=value;audienceSelect.append(option);}
    audienceSelect.value='classified';audienceSelect.addEventListener('change',renderAudienceHint);label.append(audienceSelect);
    const hint=el('p','muted');hint.id='assistant-audience-hint';
    audienceSave=textButton('Salvar público','button secondary',async()=>{
      if(!assistant || audienceSave.disabled) return;
      audienceSave.disabled=true;const audience=audienceSelect.value;$('assistant-audience-status').textContent='Salvando público…';
      try {assistant=await api('/assistant','PUT',{audience});renderAssistant();$('assistant-audience-status').textContent='Público salvo.'+(assistant.enabled?' Vale para as próximas mensagens.':' A chave geral continua desligada.');}
      catch(error) {$('assistant-audience-status').textContent=error.message;}
      finally {audienceSave.disabled=false;}
    });audienceSave.id='assistant-audience-save';
    const status=el('p','form-status assistant-audience-status');status.id='assistant-audience-status';status.setAttribute('role','status');
    box.append(label,hint,audienceSave,status);anchor.parentNode.insertBefore(box,anchor);renderAudienceHint();
  }
  buildAudienceControls();
  async function refreshAssistant() {assistant=await api('/assistant');rulesDraft=assistant.rules.map(rule=>({...rule}));renderAssistant();}
  function renderRules() {
    const fragment=document.createDocumentFragment();
    rulesDraft.forEach((rule,index)=>{
      const card=el('div','rule-card'+(rule.enabled?'':' off')),head=el('div','rule-head');
      const title=el('input','cell-input');title.value=rule.title;title.maxLength=80;title.setAttribute('aria-label','Título da regra');title.addEventListener('input',()=>{rule.title=title.value;});
      const enabled=el('label','check'),box=el('input');box.type='checkbox';box.checked=rule.enabled;box.addEventListener('change',()=>{rule.enabled=box.checked;card.classList.toggle('off',!rule.enabled);});enabled.append(box,' Ativa');
      const remove=iconButton('trash','Remover regra',()=>{rulesDraft.splice(index,1);renderRules();});
      head.append(title,enabled,remove);
      const text=el('textarea');text.rows=3;text.maxLength=1500;text.value=rule.text;text.setAttribute('aria-label','Texto da regra');text.addEventListener('input',()=>{rule.text=text.value;});
      card.append(head,text);fragment.append(card);
    });
    if(!rulesDraft.length) fragment.append(empty('Nenhuma regra. A IA responderá só com o catálogo e a base.'));
    $('rules-list').replaceChildren(fragment);
  }
  function renderAssistant() {
    if(!assistant) return;
    $('assistant-enabled').checked=assistant.enabled;
    if(audienceSelect) {audienceSelect.value=assistant.audience || 'classified';renderAudienceHint();}
    $('assistant-summary').textContent=`Público: ${AUDIENCE_LABEL[assistant.audience || 'classified']}. Contatos em rascunho: ${assistant.counts.draft} · classificados em automático: ${assistant.counts.auto}.`+(assistant.ai?'':' Configure a IA acima para usar.');
    const names=new Map(C.chats().map(chat=>[chat.jid,chat.name])),fragment=document.createDocumentFragment();
    for(const entry of assistant.log) {
      const row=el('li','log-row'),who=names.get(entry.jid) || phoneLabel(entry.jid.split('@')[0]);
      row.append(el('b','',`${ACTION_LABEL[entry.action] || entry.action} · ${who}`),el('small','muted',`${dateTime(entry.at)} — ${entry.detail || ''}`));fragment.append(row);
    }
    if(!assistant.log.length) fragment.append(el('li','muted','Ainda sem atividade.'));
    $('assistant-log').replaceChildren(fragment);
    renderRules();
  }
  $('assistant-enabled').addEventListener('change',async()=>{
    const wanted=$('assistant-enabled').checked;
    const audience=assistant?.audience || 'classified',target=audience==='all'?'todos os contatos individuais':audience==='new'?'conversas novas sem histórico anterior e suas próximas mensagens':'apenas aos contatos marcados como “Automática”';
    if(wanted && !confirm('Ligar as respostas automáticas? A IA passará a responder sozinha, pelo seu WhatsApp, a '+target+'. Contatos em “Desligada”, em rascunho ou com automações pausadas mantêm sua escolha.')) {$('assistant-enabled').checked=false;return;}
    try {assistant=await api('/assistant','PUT',{enabled:wanted});renderAssistant();$('assistant-status').textContent=wanted?'Respostas automáticas ligadas.':'Respostas automáticas desligadas: contatos em "Automática" passam a receber só rascunho.';}
    catch(error) {$('assistant-enabled').checked=!wanted;$('assistant-status').textContent=error.message;}
  });
  $('rule-add').addEventListener('click',()=>{rulesDraft.push({id:'',title:'Nova regra',text:'',enabled:true});renderRules();});
  $('rules-save').addEventListener('click',async()=>{
    $('rules-save').disabled=true;
    try {assistant=await api('/assistant','PUT',{rules:rulesDraft});rulesDraft=assistant.rules.map(rule=>({...rule}));renderAssistant();$('rules-status').textContent='Regras salvas. Valem para as próximas respostas.';}
    catch(error) {$('rules-status').textContent=error.message;}finally {$('rules-save').disabled=false;}
  });

  // Rascunho preparado pela IA entra no editor ao abrir a conversa (ou quando chega com ela aberta), só se o editor estiver vazio.
  const insertedDrafts=new Set();
  function applyDraft() {
    const selected=C.selected();if(!selected) return;
    const chat=C.chats().find(item=>item.jid===selected.jid),draft=chat?.aiDraft,last=chat?.lastMessage;
    if(!draft || !last || last.fromMe || draft.messageId!==last.id || insertedDrafts.has(selected.jid+draft.messageId) || $('message-text').value.trim()) return;
    insertedDrafts.add(selected.jid+draft.messageId);C.insertDraft(draft.text);
    notice('Rascunho da IA pronto no editor. Revise antes de enviar.',true);
  }
  C.hooks.open.push(applyDraft);C.hooks.sync.push(applyDraft);
  $('ai-suggest').addEventListener('click',guard(async()=>{
    const selected=C.selected();if(!selected) {notice('Abra uma conversa primeiro.');return;}
    const snapshot=C.contextSnapshot?.(),originalText=$('message-text').value;
    $('ai-suggest').disabled=true;notice('A IA está lendo as mensagens recentes da conversa…');
    try {
      const result=await api('/assistant/draft','POST',{jid:selected.jid},180000),current=C.contextSnapshot?.();
      if(C.selected()?.jid!==selected.jid || $('message-text').value!==originalText || (snapshot && current && (current.selection!==snapshot.selection || current.revision!==snapshot.revision || current.lastMessageId!==snapshot.lastMessageId)) || (result.contextLastId && current?.lastTextId && result.contextLastId!==current.lastTextId)) {notice('A conversa ou o rascunho mudou. Clique em Sugerir com IA para gerar uma sugestão atualizada.');return;}
      if(result.handoff) {notice('A IA sugere chamar um atendente: não há resposta segura na base.');return;}
      if(!result.text) {notice('A IA não gerou uma resposta.');return;}
      C.insertDraft(result.text);notice('Sugestão inserida no editor. Revise antes de enviar.',true);
    } finally {$('ai-suggest').disabled=false;}
  }));

  // Classificação na página Contatos: um contato por vez ou todos os listados.
  async function setMode(chat,mode) {const detail=await api('/contact?jid='+encodeURIComponent(chat.jid),'PATCH',{aiMode:mode});Object.assign(chat,detail);}
  $('contacts-bulk-apply').addEventListener('click',guard(async()=>{
    const mode=$('contacts-bulk').value,list=listedContacts();
    if(!mode) {notice('Escolha o modo de IA para aplicar.');return;}
    if(!list.length) {notice('Nenhum contato listado.');return;}
    if(!confirm(`Definir IA "${MODE_LABEL[mode]}" para ${list.length} contato(s) listado(s)?`+(mode==='auto'?'\nA IA responderá sozinha quando a chave de respostas automáticas estiver ligada.':''))) return;
    await api('/assistant/classify','POST',{jids:list.map(chat=>chat.jid),aiMode:mode});
    for(const chat of list) chat.aiMode=mode;
    renderContacts();notice(`${list.length} contato(s) atualizado(s).`,true);
  }));

  // ---------- Navegação ----------
  for(const [id,page] of [['nav-contacts','page-contacts'],['nav-knowledge','page-knowledge'],['nav-products','page-products'],['nav-ai','page-ai']]) $(id).addEventListener('click',()=>C.showView(page,id));
  $('ai-card').addEventListener('click',()=>C.showView('page-ai','nav-ai'));
  $('metric-products-button').addEventListener('click',()=>C.showView('page-products','nav-products'));
  $('metric-docs-button').addEventListener('click',()=>C.showView('page-knowledge','nav-knowledge'));
  C.hooks.view.push(name=>{
    view=name;
    if(name==='page-knowledge') guard(refreshKb)();
    if(name==='page-products') guard(refreshProducts)();
    if(name==='page-ai') {guard(refreshAi)();guard(refreshAssistant)();}
    if(name==='page-contacts') renderContacts();
  });
  C.hooks.sync.push(()=>{if(view==='page-contacts') renderContacts();});
  C.hooks.select.push(renderPanelProducts);

  // Carga inicial silenciosa: alimenta contadores e a busca sem interromper o uso.
  Promise.allSettled([api('/kb').then(result=>{docs=result.documents;}),api('/products').then(result=>{products=result.products;}),api('/ai').then(result=>{ai=result;})]).then(()=>{renderCounters();renderKb();renderProducts();renderPanelProducts();renderAi();});
})();
