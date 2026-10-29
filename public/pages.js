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
      const row=el('tr'),name=el('td','doc-name');name.append(icon('doc'),el('span','',doc.name));
      const actions=el('td','row-actions');actions.append(iconButton('eye','Ver conteúdo',()=>viewDoc(doc)),iconButton('trash','Excluir documento',()=>removeDoc(doc)));
      row.append(name,el('td','',doc.type.toUpperCase()),el('td','',bytes(doc.size)),el('td','',dateTime(doc.createdAt)),el('td','',String(doc.chunks)),actions);rows.append(row);
    }
    if(!docs.length) {const row=el('tr'),cell=el('td','empty-cell','Nenhum documento ainda. Envie um catálogo, uma tabela de preços ou as políticas da empresa.');cell.colSpan=6;row.append(cell);rows.append(row);}
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
    $('kb-status').textContent=failures.length?failures.join(' · '):list.length?`${list.length-failures.length} documento(s) adicionado(s).`:'';
    await refreshKb();
  }
  $('kb-file').addEventListener('change',guard(async()=>{const files=[...$('kb-file').files];$('kb-file').value='';if(files.length) await uploadFiles(files);}));
  $('kb-drop').addEventListener('click',()=>$('kb-file').click());
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

  // ---------- Produtos ----------
  async function thumbnail(product,holder) {
    if(!product.imageMime) return;
    const key=product.id+product.imageMime;
    if(!thumbs.has(key)) {const image=await api('/product-image?id='+product.id);thumbs.set(key,URL.createObjectURL(new Blob([toBytes(image.base64)],{type:image.mimeType})));}
    const img=el('img');img.src=thumbs.get(key);img.alt=product.name;holder.replaceChildren(img);
  }
  async function useProduct(product) {
    if(!C.selected()) {C.showView('workspace','nav-conversations');notice('Abra uma conversa e escolha o produto novamente.');return;}
    let file=null;
    if(product.imageMime) {const image=await api('/product-image?id='+product.id);file=new File([toBytes(image.base64)],'produto.'+(image.mimeType==='image/jpeg'?'jpg':image.mimeType.split('/')[1]),{type:image.mimeType});}
    C.showView('workspace','nav-conversations');C.insertDraft(product.message,file);
    notice('Ficha do produto inserida no editor. Revise e envie.',true);
  }
  function renderProducts() {
    const search=normalize($('products-search').value),fragment=document.createDocumentFragment();
    const list=products.filter(product=>!search || normalize(`${product.name} ${product.sku} ${product.category} ${product.description}`).includes(search));
    for(const product of list) {
      const card=el('article','product-card'),photo=el('div','product-photo');photo.append(icon('box'));thumbnail(product,photo).catch(()=>{});
      const body=el('div','product-body');body.append(el('strong','',product.name),el('span','product-price',money(product.price)));
      const meta=[product.sku&&'Cód. '+product.sku,product.warranty&&'Garantia '+product.warranty,product.category].filter(Boolean).join(' · ');
      if(meta) body.append(el('small','muted',meta));
      if(product.description) body.append(el('p','product-description',product.description));
      const actions=el('div','product-actions');
      actions.append(textButton('Usar na conversa','button primary',()=>useProduct(product),'send'),iconButton('copy','Copiar mensagem',async()=>{await navigator.clipboard.writeText(product.message);notice('Mensagem copiada.',true);}),iconButton('edit','Editar produto',()=>openProduct(product)),iconButton('trash','Excluir produto',()=>removeProduct(product)));
      card.append(photo,body,actions);fragment.append(card);
    }
    if(!list.length) fragment.append(empty(products.length?'Nenhum produto corresponde à busca.':'Nenhum produto ainda. Cadastre um ou importe da base de conhecimento com IA.'));
    $('products-grid').replaceChildren(fragment);
  }
  function renderPanelProducts() {
    const search=normalize($('panel-products-search').value),fragment=document.createDocumentFragment();
    const list=products.filter(product=>!search || normalize(`${product.name} ${product.sku}`).includes(search));
    $('panel-products-count').textContent=products.length;
    for(const product of list) {
      const button=el('button','template-shortcut');button.type='button';button.title=C.selected()?'Inserir no editor':'Selecione uma conversa para usar este produto';button.disabled=!C.selected();
      button.append(el('strong','',product.name),el('small','',money(product.price)+(product.warranty?' · Garantia '+product.warranty:'')));button.addEventListener('click',guard(()=>useProduct(product)));fragment.append(button);
    }
    if(!list.length) fragment.append(empty(products.length?'Nada encontrado.':'Cadastre produtos na página Produtos.'));
    $('panel-products').replaceChildren(fragment);
  }
  function openProduct(product=null) {
    editing=product;$('product-title').textContent=product?'Editar produto':'Novo produto';$('product-error').textContent='';
    $('product-name').value=product?.name || '';$('product-price').value=product?.price!=null?String(product.price).replace('.',','):'';$('product-sku').value=product?.sku || '';
    $('product-warranty').value=product?.warranty || '';$('product-category').value=product?.category || '';$('product-description').value=product?.description || '';
    $('product-image').value='';$('product-image-remove').checked=false;$('product-image-remove-row').hidden=!product?.imageMime;$('product-dialog').showModal();
  }
  $('product-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {
      const input={name:$('product-name').value,price:$('product-price').value,sku:$('product-sku').value,warranty:$('product-warranty').value,category:$('product-category').value,description:$('product-description').value};
      const file=$('product-image').files[0];
      if(file) input.image={base64:await fileBase64(file),mimeType:file.type};
      else if($('product-image-remove').checked) input.removeImage=true;
      if(editing) {await api('/products?id='+editing.id,'PATCH',input,undefined,60000);thumbs.delete(editing.id+editing.imageMime);}
      else await api('/products','POST',input,undefined,60000);
      $('product-dialog').close();await refreshProducts();notice('Produto salvo.',true);
    } catch(error) {$('product-error').textContent=error.message;}finally {button.disabled=false;}
  });
  async function removeProduct(product) {
    if(!confirm(`Excluir o produto "${product.name}"?`)) return;
    await api('/products?id='+product.id,'DELETE');await refreshProducts();notice('Produto excluído.',true);
  }
  $('product-new').addEventListener('click',()=>openProduct());
  $('products-search').addEventListener('input',renderProducts);
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
      const warranty=el('input','cell-input');warranty.value=candidate.warranty;warranty.maxLength=120;
      const source=el('td','',candidate.source);if(candidate.existingId) source.append(el('span','badge','Já cadastrado: atualiza'));
      const first=el('td'),second=el('td'),third=el('td'),fourth=el('td');first.append(pick);second.append(name);third.append(price);fourth.append(warranty);
      row.append(first,second,third,fourth,source);row.collect=()=>pick.checked?{...candidate,name:name.value,price:price.value,warranty:warranty.value}:null;fragment.append(row);
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
  let lastDefaultModel='';
  function renderAi() {
    if(!ai) return;
    const options=document.createDocumentFragment();
    for(const [id,item] of Object.entries(ai.providers)) {const option=el('option','',item.label);option.value=id;options.append(option);}
    $('ai-provider').replaceChildren(options);$('ai-provider').value=ai.provider;
    $('ai-model').value=ai.model;$('ai-base').value=ai.baseUrl;$('ai-key').value='';lastDefaultModel=ai.providers[ai.provider].model;
    syncProviderHints();
    $('ai-key-hint').textContent=ai.hasKey?'Uma chave está salva neste computador. Cole outra para trocar.':'A chave fica só neste computador e nunca volta para a tela.';
    $('ai-clear').hidden=!ai.hasKey;
  }
  function syncProviderHints() {
    const item=ai.providers[$('ai-provider').value];
    $('ai-model').placeholder=item.model || 'nome do modelo';$('ai-base').placeholder=item.baseUrl || 'https://seu-servidor/v1';
    $('ai-key').placeholder=item.key?'Cole a chave para salvar ou trocar':'Opcional para este provedor';
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
  function renderContacts() {
    const search=normalize($('contacts-search').value),status=$('contacts-status').value,fragment=document.createDocumentFragment();
    const list=C.chats().filter(chat=>(!status || chat.status===status) && (!search || normalize(`${chat.name} ${chat.jid} ${(chat.labels || []).join(' ')}`).includes(search)));
    for(const chat of list) {
      const row=el('tr','clickable'),who=el('td','doc-name'),open=el('button','link-button',chat.name);open.type='button';open.addEventListener('click',()=>C.openChat(chat));
      who.append(el('span','avatar',initials(chat.name)),open);
      const labels=el('td','labels');for(const label of chat.labels || []) labels.append(el('span','chip',label));
      const phone=chat.jid.endsWith('@lid')?'Identificador privado':phoneLabel(chat.jid.split('@')[0]);
      row.append(who,el('td','',phone),labels,el('td','',statuses[chat.status] || statuses.open),el('td','',String((chat.notes || []).length)),el('td','',chat.lastMessage?.text || (chat.lastMessage?.type && chat.lastMessage.type!=='text'?'Anexo':'—')));
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

  // ---------- Navegação ----------
  for(const [id,page] of [['nav-contacts','page-contacts'],['nav-knowledge','page-knowledge'],['nav-products','page-products'],['nav-ai','page-ai']]) $(id).addEventListener('click',()=>C.showView(page,id));
  $('ai-card').addEventListener('click',()=>C.showView('page-ai','nav-ai'));
  $('metric-products-button').addEventListener('click',()=>C.showView('page-products','nav-products'));
  $('metric-docs-button').addEventListener('click',()=>C.showView('page-knowledge','nav-knowledge'));
  C.hooks.view.push(name=>{
    view=name;
    if(name==='page-knowledge') guard(refreshKb)();
    if(name==='page-products') guard(refreshProducts)();
    if(name==='page-ai') guard(refreshAi)();
    if(name==='page-contacts') renderContacts();
  });
  C.hooks.sync.push(()=>{if(view==='page-contacts') renderContacts();});
  C.hooks.select.push(renderPanelProducts);

  // Carga inicial silenciosa: alimenta contadores e a busca sem interromper o uso.
  Promise.allSettled([api('/kb').then(result=>{docs=result.documents;}),api('/products').then(result=>{products=result.products;}),api('/ai').then(result=>{ai=result;})]).then(()=>{renderCounters();renderKb();renderProducts();renderPanelProducts();renderAi();});
})();
