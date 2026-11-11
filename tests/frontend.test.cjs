const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const appFile=path.join(__dirname,'..','public','app.js');
const jid='5511998765432@s.whatsapp.net';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
const findClass=(node,name)=>descendants(node).find(child=>String(child.className||'').split(' ').includes(name));
const audio=(id='audio-1',chatJid=jid)=>({...message(1),id,jid:chatJid,type:'audio',text:'',key:{id,remoteJid:chatJid,fromMe:true}});
const job=(overrides={})=>({id:'transcription-1',jid,messageId:'audio-1',provider:'whisper',model:'base',status:'queued',createdAt:'2026-10-28T12:00:00.000Z',updatedAt:'2026-10-28T12:00:00.000Z',...overrides});

// Executa o app sem transformar a fonte nem expor seu estado privado.
// Apenas DOM, temporizador periódico e HTTP são substituídos nesta VM.
function element(tag='div',fragment=false) {
  let ownText='';
  const listeners=new Map();
  return {
    tagName:tag.toUpperCase(),fragment,children:[],value:'',hidden:false,
    disabled:false,readOnly:false,checked:false,open:false,files:[],dataset:{},
    scrollHeight:100,scrollTop:0,clientHeight:100,classList:{toggle(){},add(){},remove(){}},
    get textContent() {return ownText+this.children.map(child=>child.textContent).join('');},
    set textContent(value) {ownText=String(value);this.children=[];},
    get firstElementChild() {return this.children[0];},
    append(...children) {for(const child of children) this.children.push(...(child.fragment?child.children:[child]));},
    replaceChildren(...children) {ownText='';this.children=[];this.append(...children);},
    addEventListener(type,listener) {
      if(!listeners.has(type)) listeners.set(type,[]);
      listeners.get(type).push(listener);
    },
    emit(type,event={}) {
      return Promise.all((listeners.get(type)||[]).map(listener=>listener({preventDefault(){},target:this,...event})));
    },
    setAttribute(){},removeAttribute(name){delete this[name];},scrollIntoView(){},focus(){},pause(){this.paused=true;},load(){},
    showModal() {this.open=true;},close() {this.open=false;return this.emit('close');},requestSubmit(){return this.emit('submit');},click(){return this.emit('click');}
  };
}

function message(number) {
  return {
    id:String(number),jid,fromMe:true,text:'Mensagem '+number,type:'text',
    timestamp:1793200000000+number*1000,status:'DELIVERY_ACK',
    mimeType:null,fileName:null,key:{id:String(number),remoteJid:jid,fromMe:true}
  };
}

const pagesFile=path.join(__dirname,'..','public','pages.js');
async function createBrowser({count=0,onSend=async()=>{},onDelete=async()=>({deleted:true}),onAssistantDraft=async()=>({text:'Sugestão contextual'}),onMessages=async()=>{},onForward=async()=>message(2),onContactsSync=async()=>({total:1,named:1}),onMedia=async()=>({base64:'aGVsbG8=',mimeType:'audio/ogg',fileName:'audio.ogg'}),scheduleModule,FileReader,chatRecords,templates=[],historyRecords,onTranscriptions=async()=>[],onTranscriptionSettings=async()=>{},aiConfigured=false,withPages=false,withMedia=false,withIntersection=false,kbDocs=[],catalog=[]}={}) {
  const nodes=new Map(),intervals=[],requests=[],copied=[],createdUrls=[],revokedUrls=[];
  class BrowserURL extends URL {static createObjectURL(blob) {const url=URL.createObjectURL(blob);createdUrls.push(url);return url;}static revokeObjectURL(url) {revokedUrls.push(url);URL.revokeObjectURL(url);}}
  let history=historyRecords || Array.from({length:count},(_,index)=>message(index+1));
  let transcriptionSettings={defaultProvider:'whisper',whisperModel:'base',language:'pt',aiConfigured,aiModel:'gpt-transcribe'};
  const get=id=>{if(!nodes.has(id)) nodes.set(id,element());return nodes.get(id);};
  const document={title:'Whats AI',
    getElementById:get,querySelector:()=>({content:'test-session'}),querySelectorAll:()=>[],
    createElement:element,createElementNS:()=>element('svg'),createDocumentFragment:()=>element('fragment',true),
    addEventListener(){},visibilityState:'visible'
  };
  async function fetchLocal(address,options={}) {
    const url=new URL(address,'http://127.0.0.1:8766');
    const input=options.body?JSON.parse(options.body):undefined;
    requests.push({path:url.pathname,jid:url.searchParams.get('jid'),method:options.method||'GET',input});
    let output;
    if(url.pathname==='/health') {requests.pop();return {ok:true,json:async()=>({service:'whatsapp-local',version:1,build:'test',current:'test',stale:false})};}
    else if(url.pathname==='/api/settings') output={templates};
    else if(url.pathname==='/api/transcription/settings') {
      const result=await onTranscriptionSettings({method:options.method||'GET',input});
      if(options.method==='PATCH') transcriptionSettings={...transcriptionSettings,...(input.whisperModel?{whisperModel:input.whisperModel}:{}),...(input.language?{language:input.language}:{}),...(input.aiApiKey?{aiConfigured:true}:{}),...(input.removeAiKey?{aiConfigured:false}:{})};
      output=result || transcriptionSettings;
    }
    else if(url.pathname==='/api/transcriptions') output=await onTranscriptions({jid:url.searchParams.get('jid'),method:options.method||'GET',input});
    else if(url.pathname==='/api/transcriptions/discover') output={discovered:0};
    else if(url.pathname==='/api/connection') output={state:'connected',reachable:true,exists:true,phone:'5511000000000',instanceName:'teste'};
    else if(url.pathname==='/api/chats') output=chatRecords || [{jid,name:'Ana',unread:0,status:'open',labels:[],notes:[],lastMessage:history.at(-1)||null}];
    else if(url.pathname==='/api/contact') output={status:'open',labels:[],notes:[]};
    else if(url.pathname==='/api/contacts/sync') output=await onContactsSync(input);
    else if(url.pathname==='/api/forward') output=await onForward(input);
    else if(url.pathname==='/api/messages') {
      const page=Number(url.searchParams.get('page')||1);
      const descending=history.filter(record=>record.jid===url.searchParams.get('jid')).reverse();
      output={messages:descending.slice((page-1)*50,page*50).reverse(),page,pages:Math.max(1,Math.ceil(history.length/50)),total:history.length};
      await onMessages({page});
    } else if(['/api/send','/api/send-media','/api/send-sticker'].includes(url.pathname)) {
      const input=JSON.parse(options.body);
      await onSend(input);
      output={...message(history.length+1),text:input.text || input.caption || ''};
    } else if(url.pathname==='/api/messages/delete') output=await onDelete(input);
    else if(url.pathname==='/api/assistant/draft') output=await onAssistantDraft(input);
    else if(url.pathname==='/api/contact/details') output={name:'Ana',phone:'5511998765432',about:'Atendimento',capabilities:{disappearingMessages:false}};
    else if(url.pathname==='/api/read') output={read:true};
    else if(url.pathname==='/api/media') output=await onMedia({id:url.searchParams.get('id'),jid:url.searchParams.get('jid'),signal:options.signal});
    else if(url.pathname==='/api/kb') output={documents:kbDocs,ai:false};
    else if(url.pathname==='/api/products') output={products:catalog};
    else if(url.pathname==='/api/ai') output={provider:'openai',model:'',baseUrl:'',hasKey:false,configured:false,providers:{openai:{label:'OpenAI',model:'gpt-4o-mini',baseUrl:'',key:true}}};
    else throw new Error('Requisição inesperada no teste: '+address);
    return {ok:true,json:async()=>output};
  }
  let requestSequence=0;
  const observers=[];
  class IntersectionObserver {constructor(callback){this.callback=callback;this.targets=new Set();observers.push(this);}observe(target){this.targets.add(target);}unobserve(target){this.targets.delete(target);}disconnect(){this.targets.clear();}}
  const context=vm.createContext({
    document,fetch:fetchLocal,Intl,Date,Map,Set,URL:BrowserURL,URLSearchParams,AbortController,AbortSignal,FileReader,File,Blob,Uint8Array,atob,WhatsAppSchedule:scheduleModule,...(withIntersection?{IntersectionObserver}:{}),
    navigator:{clipboard:{writeText:async text=>{copied.push(text);}}},
    crypto:{randomUUID:()=> 'frontend-request-'+(++requestSequence)},
    setInterval(callback,delay) {intervals.push({callback,delay});return intervals.length;},
    setTimeout,clearTimeout,clearInterval(){},window:{addEventListener(){}},location:{search:''},matchMedia:()=>({matches:false})
  });
  if(withMedia) vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','conversation-media.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(appFile,'utf8'),context,{filename:appFile});
  if(withPages) vm.runInContext(fs.readFileSync(pagesFile,'utf8'),context,{filename:pagesFile});
  await settle();
  assert.equal(get('notice').textContent,'','A inicialização do app não deve falhar.');
  assert.equal(get('chat-list').children.length,chatRecords?.length || 1);
  await get('chat-list').children[0].emit('click');
  assert.equal(get('notice').textContent,'','A seleção da conversa não deve falhar.');
  return {
    get,requests,copied,createdUrls,revokedUrls,document,
    appendRecords(records) {history.push(...records);},
    intersectMedia(id,visible=true) {for(const observer of observers) for(const target of observer.targets) if(target.dataset.mediaId===id) observer.callback([{target,isIntersecting:visible}]);},
    appendMessages(amount) {
      const start=history.length;
      history.push(...Array.from({length:amount},(_,index)=>message(start+index+1)));
    },
    async poll() {await intervals.find(interval=>interval.delay===4000).callback();},
    async pollTranscriptions() {const interval=intervals.find(interval=>interval.delay===2000);assert.ok(interval,'A transcrição precisa de polling independente.');await interval.callback();},
    async selectChat(index) {await get('chat-list').children[index].emit('click');},
    renderedMessages() {
      return get('messages').children.filter(row=>row.tagName==='ARTICLE')
        .map(row=>row.children.find(child=>child.tagName==='P')?.textContent);
    }
  };
}

test('título mostra mensagens não lidas e a interface não mostra total de conversas',async()=>{
  const other='5511888888888@s.whatsapp.net';
  const browser=await createBrowser({chatRecords:[
    {jid,name:'Ana',unread:2,status:'open',labels:[],notes:[],lastMessage:message(2)},
    {jid:other,name:'Bia',unread:3,status:'open',labels:[],notes:[],lastMessage:{...message(3),jid:other,key:{...message(3).key,remoteJid:other}}}
  ]});
  assert.equal(browser.document.title,'(5) Whats AI');
  const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  assert.doesNotMatch(html,/id="metric-total-button"|id="filter-total-count"|id="chat-count"/);
});

test('links HTTP ficam clicáveis sem executar HTML ou protocolos de script',async()=>{
  const browser=await createBrowser({historyRecords:[{...message(1),text:'Veja https://example.com/catalogo?q=1 e www.example.org. <script>alert(1)</script> javascript:alert(1)'}]});
  const links=descendants(browser.get('messages')).filter(node=>node.tagName==='A');
  assert.equal(links.length,2);assert.equal(links[0].href,'https://example.com/catalogo?q=1');
  assert.equal(links[1].href,'https://www.example.org/');assert.equal(links[0].rel,'noopener noreferrer');
  assert.match(browser.get('messages').textContent,/<script>alert\(1\)<\/script>/);
});

test('vídeo carregado preserva posição e elemento quando chega outra mensagem',async()=>{
  const browser=await createBrowser({historyRecords:[{...message(1),type:'video',text:'Vídeo de exemplo'}],onMedia:async()=>({base64:'aGVsbG8=',mimeType:'video/mp4',fileName:'demo.mp4'})});
  const card=findClass(browser.get('messages'),'video-card');assert.ok(card);
  await findClass(card,'video-load').emit('click');const player=descendants(card).find(node=>node.tagName==='VIDEO');
  assert.match(player.src,/^blob:/);assert.notEqual(player.autoplay,true);player.currentTime=12;
  browser.appendMessages(1);await browser.poll();
  assert.equal(descendants(browser.get('messages')).find(node=>node.tagName==='VIDEO'),player);assert.equal(player.currentTime,12);
});

const previewPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK9sAAAAASUVORK5CYII=';
const previewJpeg=Buffer.from([255,216,255,224,0,16,74,70,73,70]).toString('base64');
test('imagem mostra prévia ao abrir a conversa sem abrir o visualizador',async()=>{
  const browser=await createBrowser({withMedia:true,historyRecords:[{...message(1),type:'image',text:'Foto recebida'}],onMedia:async()=>({base64:previewPng,mimeType:'image/png'})});
  await settle();const image=descendants(browser.get('messages')).find(node=>node.tagName==='IMG');
  assert.ok(image,'A imagem recebida precisa de uma prévia automática.');assert.match(image.src,/^blob:/);assert.equal(browser.get('media-viewer').open,false);
  assert.equal(browser.requests.filter(req=>req.path==='/api/media').length,1);
});

test('imagem com miniatura e vídeo com capa não baixam o arquivo automaticamente',async()=>{
  const browser=await createBrowser({withMedia:true,historyRecords:[{...message(1),type:'image',jpegThumbnail:previewJpeg},{...message(2),type:'video',jpegThumbnail:previewJpeg,durationSeconds:63,fileName:'video.mp4'}]});
  const image=descendants(browser.get('messages')).find(node=>node.tagName==='IMG'),player=descendants(browser.get('messages')).find(node=>node.tagName==='VIDEO');
  assert.ok(image);assert.match(image.src,/^data:image\/jpeg;base64,/);assert.ok(player);assert.match(player.poster,/^data:image\/jpeg;base64,/);assert.equal(player.hidden,false);
  assert.equal(player.src,undefined);assert.notEqual(player.autoplay,true);assert.equal(player.preload,'none');assert.match(findClass(browser.get('messages'),'video-card').textContent,/1:03/);
  assert.equal(browser.requests.filter(req=>req.path==='/api/media').length,0);
});

test('prévia automática de imagem e abertura simultânea compartilham a requisição',async()=>{
  const started=deferred(),finish=deferred();
  const browser=await createBrowser({withMedia:true,historyRecords:[{...message(1),type:'image'}],onMedia:async()=>{started.resolve();await finish.promise;return {base64:previewPng,mimeType:'image/png'};}});
  assert.equal(browser.requests.filter(req=>req.path==='/api/media').length,1);await started.promise;const opening=findClass(browser.get('messages'),'attachment-preview-button').emit('click');finish.resolve();await opening;
  assert.equal(browser.requests.filter(req=>req.path==='/api/media').length,1);assert.equal(browser.get('media-viewer').open,true);
});

test('falha da prévia de imagem mantém a conversa e permite tentar abrir novamente',async()=>{
  let attempts=0;const browser=await createBrowser({withMedia:true,historyRecords:[{...message(1),type:'image'}],onMedia:async()=>{if(++attempts===1) throw Error('Mídia indisponível');return {base64:previewPng,mimeType:'image/png'};}});
  await settle();assert.match(findClass(browser.get('messages'),'attachment-card').textContent,/Prévia indisponível/);assert.equal(browser.get('notice').textContent,'');
  await findClass(browser.get('messages'),'attachment-preview-button').emit('click');assert.equal(attempts,2);assert.equal(browser.get('media-viewer').open,true);
});

test('imagem e vídeo anexados mostram prévia local e liberam URLs ao substituir e remover',async()=>{
  const browser=await createBrowser({withMedia:true});
  browser.get('attachment').files=[new File(['foto'],'foto.png',{type:'image/png'})];await browser.get('attachment').emit('change');
  let preview=browser.get('attachment-preview');assert.equal(preview.hidden,false);assert.equal(preview.children.length,1,'O anexo deve ter uma prévia local.');assert.equal(preview.firstElementChild.tagName,'IMG');const imageUrl=preview.firstElementChild.src;
  browser.get('attachment').files=[new File(['vídeo'],'video.mp4',{type:'video/mp4'})];await browser.get('attachment').emit('change');
  preview=browser.get('attachment-preview');assert.equal(preview.firstElementChild.tagName,'VIDEO');assert.equal(preview.firstElementChild.controls,true);assert.equal(preview.firstElementChild.preload,'metadata');assert.notEqual(preview.firstElementChild.autoplay,true);
  const videoUrl=preview.firstElementChild.src;assert.ok(browser.revokedUrls.includes(imageUrl));assert.equal(browser.requests.some(req=>req.path==='/api/send-media'),false);
  await browser.get('remove-attachment').emit('click');assert.ok(browser.revokedUrls.includes(videoUrl));assert.equal(preview.hidden,true);assert.equal(preview.children.length,0);
});

test('trocar de conversa ou enviar libera a prévia local do anexo',async()=>{
  class Reader {readAsDataURL(){this.result='data:image/png;base64,aGVsbG8=';this.onload();}}
  const browser=await createBrowser({withMedia:true,FileReader:Reader,chatRecords:[{jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:'5511999999999@s.whatsapp.net',name:'Bruno',unread:0,status:'open',labels:[]}]});
  browser.get('attachment').files=[new File(['foto'],'foto.png',{type:'image/png'})];await browser.get('attachment').emit('change');assert.equal(browser.get('attachment-preview').children.length,1);const first=browser.get('attachment-preview').firstElementChild.src;
  await browser.selectChat(1);assert.ok(browser.revokedUrls.includes(first));assert.equal(browser.get('attachment-preview').hidden,true);
  browser.get('attachment').files=[new File(['foto'],'outra.png',{type:'image/png'})];await browser.get('attachment').emit('change');const sent=browser.get('attachment-preview').firstElementChild.src;
  await browser.get('composer').emit('submit');assert.ok(browser.revokedUrls.includes(sent));assert.equal(browser.get('attachment-preview').hidden,true);assert.equal(browser.requests.filter(req=>req.path==='/api/send-media').length,1);
});

const imageMessage=number=>({...message(number),type:'image'});
const imageMedia=async()=>({base64:previewPng,mimeType:'image/png'});
const liveMediaUrls=browser=>browser.createdUrls.filter(url=>!browser.revokedUrls.includes(url));
test('cache de prévias limita entradas e revoga URLs antigas ao carregar muito histórico',async()=>{
  const browser=await createBrowser({withMedia:true,historyRecords:Array.from({length:40},(_,index)=>imageMessage(index+1)),onMedia:imageMedia});await settle();
  assert.equal(browser.createdUrls.length,40);assert.ok(liveMediaUrls(browser).length<=24,'O histórico não pode reter todas as imagens.');assert.ok(browser.revokedUrls.length>=16);
});

test('cache de prévias também limita bytes mesmo com poucas imagens grandes',async()=>{
  const bytes=Buffer.alloc(4*1024*1024);Buffer.from(previewPng,'base64').copy(bytes);
  const browser=await createBrowser({withMedia:true,historyRecords:Array.from({length:5},(_,index)=>imageMessage(index+1)),onMedia:async()=>({base64:bytes.toString('base64'),mimeType:'image/png'})});await settle();
  assert.equal(browser.createdUrls.length,5);assert.ok(liveMediaUrls(browser).length<=4,'Bytes de Uint8Array e Blob devem entrar no orçamento de 32 MiB.');
});

test('trocar de conversa libera mídia recebida e recria players antigos apenas sob demanda',async()=>{
  const other='5511999999999@s.whatsapp.net',browser=await createBrowser({withMedia:true,historyRecords:[imageMessage(1),audio(),{...message(3),type:'video'}],onMedia:async({id})=>id==='1'?imageMedia():{base64:'aGVsbG8=',mimeType:id==='3'?'video/mp4':'audio/ogg'},chatRecords:[{jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:other,name:'Bruno',unread:0,status:'open',labels:[]}]});
  await findClass(browser.get('messages'),'audio-play').emit('click');await findClass(browser.get('messages'),'video-load').emit('click');
  const oldPlayers=descendants(browser.get('messages')).filter(node=>['AUDIO','VIDEO'].includes(node.tagName)),oldUrls=[...browser.createdUrls];await browser.selectChat(1);
  assert.ok(oldUrls.every(url=>browser.revokedUrls.includes(url)));assert.ok(oldPlayers.every(player=>player.paused && player.src===undefined));
  await browser.selectChat(0);const newPlayers=descendants(browser.get('messages')).filter(node=>['AUDIO','VIDEO'].includes(node.tagName));assert.ok(newPlayers.every(player=>!oldPlayers.includes(player)));assert.ok(newPlayers.every(player=>player.src===undefined));
});

test('visualizador aberto e vídeo em reprodução resistem à pressão do cache e liberam ao sair',async()=>{
  const other='5511999999999@s.whatsapp.net',browser=await createBrowser({withMedia:true,historyRecords:[imageMessage(1),{...message(2),type:'video'}],onMedia:async({id})=>id==='2'?{base64:'aGVsbG8=',mimeType:'video/mp4'}:imageMedia(),chatRecords:[{jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:other,name:'Bruno',unread:0,status:'open',labels:[]}]});
  await findClass(browser.get('messages'),'attachment-preview-button').emit('click');const imageUrl=browser.get('media-viewer-content').firstElementChild.src;
  await findClass(browser.get('messages'),'video-load').emit('click');const player=descendants(browser.get('messages')).find(node=>node.tagName==='VIDEO');player.paused=false;player.currentTime=12;const videoUrl=player.src;
  browser.appendRecords(Array.from({length:35},(_,index)=>imageMessage(index+3)));await browser.poll();await settle();
  assert.equal(browser.revokedUrls.includes(imageUrl),false);assert.equal(browser.revokedUrls.includes(videoUrl),false);assert.equal(player.currentTime,12);
  await browser.selectChat(1);assert.equal(browser.revokedUrls.includes(videoUrl),true);assert.equal(browser.revokedUrls.includes(imageUrl),false);
  await browser.get('media-viewer').close();assert.ok(browser.revokedUrls.includes(imageUrl));assert.equal(liveMediaUrls(browser).length,0);
});

test('resposta de mídia atrasada não recria cache da conversa anterior',async()=>{
  const finish=deferred(),browser=await createBrowser({withMedia:true,historyRecords:[imageMessage(1)],onMedia:async()=>{await finish.promise;return imageMedia();},chatRecords:[{jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:'5511999999999@s.whatsapp.net',name:'Bruno',unread:0,status:'open',labels:[]}]});
  await browser.selectChat(1);finish.resolve();await settle();assert.equal(browser.createdUrls.length,0);assert.equal(browser.get('notice').textContent,'');
});

test('prévia sem miniatura espera entrar na área visível e baixa no máximo duas imagens por vez',async()=>{
  const finish=deferred();let active=0,maximum=0;
  const browser=await createBrowser({withMedia:true,withIntersection:true,historyRecords:Array.from({length:8},(_,index)=>imageMessage(index+1)),onMedia:async()=>{maximum=Math.max(maximum,++active);await finish.promise;active--;return imageMedia();}});
  assert.equal(browser.requests.filter(request=>request.path==='/api/media').length,0);
  for(let id=1;id<=8;id++) browser.intersectMedia(String(id));await settle();assert.equal(browser.requests.filter(request=>request.path==='/api/media').length,2);finish.resolve();await settle();
  assert.equal(browser.createdUrls.length,8);assert.equal(maximum,2);
});

test('apagar mensagem enviada exige confirmação e não envia o rascunho',async()=>{
  const browser=await createBrowser({historyRecords:[message(1)]});
  browser.get('message-text').value='Preservar rascunho';await browser.get('message-text').emit('input');
  const button=findClass(browser.get('messages'),'message-delete');assert.ok(button);await button.emit('click');
  assert.equal(browser.get('delete-dialog').open,true);assert.equal(browser.requests.some(req=>req.path==='/api/messages/delete'),false);
  await browser.get('delete-confirm').emit('click');
  assert.equal(browser.requests.filter(req=>req.path==='/api/messages/delete').length,1);
  assert.equal(browser.get('message-text').value,'Preservar rascunho');
  assert.match(browser.get('messages').textContent,/Mensagem apagada/);
});

test('emojis entram no rascunho sem enviar a mensagem',async()=>{
  const browser=await createBrowser();browser.get('message-text').value='Olá';await browser.get('message-text').emit('input');
  await browser.get('emoji-toggle').emit('click');assert.equal(browser.get('emoji-dialog').open,true);
  assert.ok(browser.get('emoji-grid').children.length>10);await browser.get('emoji-grid').children[0].emit('click');
  assert.match(browser.get('message-text').value,/Olá.+/u);assert.equal(browser.requests.some(req=>req.path==='/api/send'),false);
});

test('Enter envia uma vez e Shift+Enter ou composição preservam o rascunho',async()=>{
  const b=await createBrowser(),editor=b.get('message-text');editor.value='Enviar pelo teclado';await editor.emit('input');let prevented=false;
  await editor.emit('keydown',{key:'Enter',preventDefault(){prevented=true;}});await settle();assert.equal(prevented,true);assert.equal(b.requests.filter(r=>r.path==='/api/send').length,1);
  editor.value='Linha que continua';await editor.emit('input');for(const extra of [{shiftKey:true},{isComposing:true},{keyCode:229},{repeat:true}]) {let prevented=false;await editor.emit('keydown',{key:'Enter',...extra,preventDefault(){prevented=true;}});assert.equal(prevented,false);}
  assert.equal(b.requests.filter(r=>r.path==='/api/send').length,1);assert.equal(editor.value,'Linha que continua');
});

test('atualiza leitura quando a última mensagem muda sem novas mensagens recebidas',async()=>{
  const incoming={...message(1),fromMe:false,key:{id:'1',remoteJid:jid,fromMe:false}};
  const chat={jid,name:'Ana',unread:2,status:'open',labels:[],lastMessage:incoming};
  const b=await createBrowser({chatRecords:[chat],historyRecords:[incoming]});
  b.appendRecords([message(2)]);chat.lastMessage=message(2);chat.unread=2;
  await b.poll();
  const read=b.requests.filter(req=>req.path==='/api/read').at(-1);
  assert.equal(read.input.lastSeenId,'2');assert.equal(chat.unread,0);
});
test('arquivo escolhido como Documento preserva essa categoria mesmo quando é imagem',async()=>{
  class Reader {readAsDataURL(){this.result='data:image/png;base64,aGVsbG8=';this.onload();}}
  const b=await createBrowser({FileReader:Reader});await b.get('attach-document').emit('click');b.get('attachment').files=[{name:'original.png',size:5,type:'image/png'}];await b.get('attachment').emit('change');await b.get('composer').emit('submit');
  assert.equal(b.requests.find(r=>r.path==='/api/send-media').input.mediaType,'document');
});
test('sugestão atrasada não aparece no contato selecionado depois',async()=>{
  const other='5511998765433@s.whatsapp.net',started=deferred(),finish=deferred(),b=await createBrowser({withPages:true,chatRecords:[{jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:other,name:'Bruno',unread:0,status:'open',labels:[]}],onAssistantDraft:async()=>{started.resolve();await finish.promise;return {text:'Resposta exclusiva da Ana'};}});
  const pending=b.get('ai-suggest').emit('click');await started.promise;await b.selectChat(1);finish.resolve();await pending;assert.doesNotMatch(b.get('message-text').value,/Resposta exclusiva/);assert.match(b.get('notice').textContent,/conversa|contato/i);
});
test('sugestão atrasada preserva o rascunho alterado durante a geração',async()=>{
  const started=deferred(),finish=deferred(),b=await createBrowser({withPages:true,onAssistantDraft:async()=>{started.resolve();await finish.promise;return {text:'Resposta antiga'};}});
  const pending=b.get('ai-suggest').emit('click');await started.promise;b.get('message-text').value='Minha nova edição';await b.get('message-text').emit('input');finish.resolve();await pending;assert.equal(b.get('message-text').value,'Minha nova edição');
});

test('remover uma figurinha permite enviar texto normalmente',async()=>{
  const browser=await createBrowser();browser.get('sticker-file').files=[{name:'figurinha.webp',size:50,type:'image/webp'}];await browser.get('sticker-file').emit('change');await browser.get('remove-attachment').emit('click');
  browser.get('message-text').value='Texto após remover a figurinha';await browser.get('message-text').emit('input');await browser.get('composer').emit('submit');
  assert.equal(browser.requests.filter(req=>req.path==='/api/send').length,1);assert.doesNotMatch(browser.get('send-status').textContent,/não têm legenda/);
});

test('enquetes recebidas mostram as opções sem tentar baixar mídia',async()=>{
  const browser=await createBrowser({historyRecords:[{...message(1),type:'poll',poll:{name:'Qual opção?',options:['Primeira','Segunda'],selectableCount:1},text:'Qual opção?'}]});
  assert.ok(findClass(browser.get('messages'),'poll-card'));assert.match(browser.get('messages').textContent,/Primeira/);assert.match(browser.get('messages').textContent,/Segunda/);assert.equal(browser.requests.some(req=>req.path==='/api/media'),false);
});

test('confirmar envio não apaga o próximo rascunho digitado durante a requisição',async()=>{
  const started=deferred(),finish=deferred();
  const browser=await createBrowser({onSend:async input=>{started.resolve(input);await finish.promise;}});
  const editor=browser.get('message-text');
  editor.value='Primeira mensagem';
  await editor.emit('input');
  const sending=browser.get('composer').emit('submit');
  const submitted=await started.promise;
  assert.equal(submitted.text,'Primeira mensagem');
  const nextDraft='Próxima mensagem ainda em rascunho';
  // Bloquear a edição durante o envio também evita a perda; se o editor
  // continuar disponível, o texto novo precisa sobreviver à confirmação.
  const canEdit=!editor.disabled && !editor.readOnly;
  if(canEdit) {editor.value=nextDraft;await editor.emit('input');}
  finish.resolve();
  await sending;
  assert.equal(browser.get('notice').textContent,'');
  if(canEdit) assert.equal(editor.value,nextDraft,'A confirmação do envio anterior apagou o novo rascunho.');
});

test('dashboard omite total de conversas e mostra as contagens acionáveis',async()=>{
  const chats=[
    {jid,name:'Ana',unread:0,status:'open',labels:[],lastMessage:null},
    {jid:'5511998765433@s.whatsapp.net',name:'Bruno',unread:2,status:'pending',labels:['Retornar'],lastMessage:null},
    {jid:'5511998765434@s.whatsapp.net',name:'Carla',unread:1,status:'closed',labels:[],lastMessage:null},
    {jid:'5511998765435@s.whatsapp.net',name:'Daniel',unread:0,status:'open',labels:[],lastMessage:null}
  ];
  const browser=await createBrowser({chatRecords:chats});
  assert.equal(browser.get('metric-unread').textContent,'2');
  assert.equal(browser.get('metric-pending').textContent,'1');
  assert.equal(browser.get('metric-closed').textContent,'1');
  assert.equal(browser.get('panel-connection-phone').textContent,'+55 11 00000-0000');
  await browser.get('nav-pending').emit('click');
  assert.equal(browser.get('chat-list').children.length,1);
  assert.match(browser.get('chat-list').textContent,/Bruno/);
  await browser.get('metric-unread-button').emit('click');
  assert.equal(browser.get('chat-list').children.length,2);
  await browser.get('nav-overview').emit('click');
  assert.equal(browser.get('page-dashboard').hidden,false);
  assert.equal(browser.get('workspace').hidden,true);
  assert.deepEqual(browser.get('dashboard-stats').children.map(card=>card.children[1].textContent),['2','1','1']);
  assert.equal(browser.get('dashboard-recent').children.length,4);
  assert.equal(browser.get('dashboard-attention-count').textContent,'1');
  assert.match(browser.get('dashboard-attention').textContent,/Bruno/);
  assert.doesNotMatch(browser.get('dashboard-attention').textContent,/Carla/);
  assert.deepEqual(browser.get('dashboard-distribution').children.map(item=>item.children[1].value),[2,1,1]);
  assert.deepEqual(browser.get('dashboard-ai-summary').children.map(item=>item.children[1].textContent),['0','0','4']);
  await browser.get('dashboard-ai-open').emit('click');
  assert.equal(browser.get('page-ai').hidden,false);
  assert.equal(browser.get('page-dashboard').hidden,true);
  await browser.get('dashboard-stats').children[0].emit('click');
  assert.equal(browser.get('page-dashboard').hidden,true);
  assert.equal(browser.get('workspace').hidden,false);
  assert.equal(browser.get('chat-list').children.length,2);
});

test('resposta rápida do painel insere no rascunho sem enviar a mensagem',async()=>{
  const sends=[];
  const browser=await createBrowser({templates:[{name:'Boas-vindas',body:'Olá! Como posso ajudar?'}],onSend:async input=>sends.push(input)});
  browser.get('message-text').value='Rascunho atual';
  await browser.get('message-text').emit('input');
  await browser.get('tab-templates').emit('click');
  assert.equal(browser.get('templates-section').hidden,false);
  assert.equal(browser.get('attendance-section').hidden,true);
  await browser.get('template-shortcuts').children[0].emit('click');
  assert.equal(browser.get('message-text').value,'Rascunho atual\nOlá! Como posso ajudar?');
  assert.equal(sends.length,0);
});

test('polling após mais de uma página nova mantém todo o histórico acessível',async()=>{
  const browser=await createBrowser({count:150});
  await browser.get('older').emit('click');
  await browser.get('older').emit('click');
  assert.equal(browser.renderedMessages().length,150);
  assert.equal(browser.get('older').hidden,true);

  // Simula voltar à aba depois de 75 mensagens novas, com três páginas
  // antigas já carregadas. Deve ser possível alcançar também as 25 do meio.
  browser.appendMessages(75);
  await browser.poll();
  for(let attempts=0;!browser.get('older').hidden && attempts<10;attempts++) {
    await browser.get('older').emit('click');
  }
  assert.equal(browser.get('notice').textContent,'');
  const rendered=new Set(browser.renderedMessages());
  const missing=Array.from({length:225},(_,index)=>'Mensagem '+(index+1)).filter(text=>!rendered.has(text));
  assert.deepEqual(missing,[],'O polling pulou mensagens que as páginas anteriores não recuperam.');
});

test('atualização mantém a posição de quem está lendo mensagens acima',async()=>{
  const browser=await createBrowser({count:30});
  const area=browser.get('messages');area.scrollHeight=2000;area.clientHeight=500;area.scrollTop=200;
  browser.appendMessages(1);await browser.poll();
  assert.equal(area.scrollTop,200,'O polling puxou a conversa para baixo durante a leitura.');
});

test('polling sem alterações preserva os elementos das mensagens e da mídia',async()=>{
  const browser=await createBrowser({count:10});
  const first=browser.get('messages').children[0];await browser.poll();
  assert.equal(browser.get('messages').children[0],first,'A atualização recriou mensagens sem nenhuma alteração.');
});

test('editar legenda durante leitura de arquivo não reutiliza o envio antigo após falha',async()=>{
  const reading=deferred(),sent=[];
  let finishFirstRead;
  class DeferredFileReader {
    readAsDataURL() {
      const complete=()=>{this.result='data:application/pdf;base64,aGVsbG8=';this.onload();};
      if(!finishFirstRead) {finishFirstRead=complete;reading.resolve();}
      else complete();
    }
  }
  const browser=await createBrowser({FileReader:DeferredFileReader,onSend:async input=>{
    sent.push(input);
    if(sent.length===1) throw new Error('Falha temporária de envio');
  }});
  const editor=browser.get('message-text'),attachment=browser.get('attachment');
  editor.value='Legenda original';
  await editor.emit('input');
  attachment.files=[{name:'documento.pdf',size:5,type:'application/pdf'}];
  await attachment.emit('change');
  const sending=browser.get('composer').emit('submit');
  await reading.promise;
  editor.value='Legenda corrigida durante leitura';
  await editor.emit('input');
  finishFirstRead();
  await sending;
  assert.equal(editor.value,'Legenda corrigida durante leitura');
  await browser.get('composer').emit('submit');
  assert.deepEqual(sent.map(input=>input.caption),['Legenda original','Legenda corrigida durante leitura'],
    'Uma nova edição precisa gerar o próximo envio, sem reutilizar a legenda antiga.');
});

test('resposta antiga não desfaz o cursor reiniciado por polling concorrente',async()=>{
  const started=deferred(),release=deferred();
  let pauseOldPage=false;
  const browser=await createBrowser({count:150,onMessages:async({page})=>{
    if(pauseOldPage && page===4) {
      pauseOldPage=false;
      started.resolve();
      await release.promise;
    }
  }});
  await browser.get('older').emit('click');
  await browser.get('older').emit('click');
  browser.appendMessages(75);
  pauseOldPage=true;
  const older=browser.get('older').emit('click');
  await started.promise;
  const polling=browser.poll();
  // Deixa o polling resolver primeiro quando as cargas são concorrentes.
  // Se forem serializadas, ele pode esperar a página antiga sem bloquear o teste.
  await settle();
  release.resolve();
  await Promise.all([older,polling]);
  for(let attempts=0;!browser.get('older').hidden && attempts<10;attempts++) {
    await browser.get('older').emit('click');
  }
  assert.equal(browser.get('notice').textContent,'');
  const rendered=new Set(browser.renderedMessages());
  const missing=Array.from({length:225},(_,index)=>'Mensagem '+(index+1)).filter(text=>!rendered.has(text));
  assert.deepEqual(missing,[],'Uma resposta atrasada pulou mensagens após o polling reiniciar a paginação.');
});

test('áudio só é transcrito após clique e usa Whisper local por padrão',async()=>{
  const browser=await createBrowser({historyRecords:[audio()],onTranscriptions:async({method,input})=>method==='POST'?job(input):[]});
  const row=browser.get('messages').children[0],provider=findClass(row,'transcription-provider'),button=findClass(row,'transcribe-button');
  assert.ok(provider,'Cada áudio deve oferecer a escolha do transcritor.');
  assert.equal(provider.value,'whisper');
  assert.equal(browser.requests.filter(request=>request.path==='/api/transcriptions' && request.method==='POST').length,0);
  await button.emit('click');
  const request=browser.requests.find(request=>request.path==='/api/transcriptions' && request.method==='POST');
  assert.deepEqual(request.input,{jid,messageId:'audio-1',provider:'whisper'});
  assert.match(row.textContent,/Na fila/);
  assert.equal(button.disabled,true);
});

test('polling de transcrição mostra resultado e permite copiar sem recriar o áudio',async()=>{
  let saved=[];
  const browser=await createBrowser({historyRecords:[audio()],onTranscriptions:async({method,input})=>{
    if(method==='POST') {saved=[job(input)];return saved[0];}return saved;
  }});
  let row=browser.get('messages').children[0];
  await findClass(row,'audio-play').emit('click'); // Abre o player local.
  row=browser.get('messages').children[0];
  const player=descendants(row).find(child=>child.tagName==='AUDIO');
  assert.ok(player,'O player precisa continuar funcionando junto à transcrição.');
  await findClass(row,'transcribe-button').emit('click');
  saved=[job({status:'completed',text:'Olá, podemos conversar amanhã?',updatedAt:'2026-10-28T12:01:00.000Z'})];
  await browser.pollTranscriptions();await browser.poll();
  assert.equal(browser.get('messages').children[0],row,'Atualizar transcrição não deve recriar a mensagem.');
  assert.equal(descendants(row).find(child=>child.tagName==='AUDIO'),player,'O polling interrompeu o player.');
  assert.match(row.textContent,/Olá, podemos conversar amanhã\?/);
  await findClass(row,'transcription-copy').emit('click');
  assert.deepEqual(browser.copied,['Olá, podemos conversar amanhã?']);
});

test('transcrições persistidas reaparecem ao voltar à conversa e não vazam para outro contato',async()=>{
  const other='5511998765433@s.whatsapp.net';
  const browser=await createBrowser({historyRecords:[audio(),audio('audio-1',other)],chatRecords:[
    {jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:other,name:'Bruno',unread:0,status:'open',labels:[]}
  ],onTranscriptions:async({jid:chat})=>chat===jid?[job({status:'completed',text:'Texto salvo da Ana'})]:[]});
  assert.match(browser.get('messages').textContent,/Texto salvo da Ana/);
  await browser.selectChat(1);
  assert.doesNotMatch(browser.get('messages').textContent,/Texto salvo da Ana/);
  await browser.selectChat(0);
  assert.match(browser.get('messages').textContent,/Texto salvo da Ana/);
});

test('resposta de transcrição atrasada não aparece na conversa selecionada depois',async()=>{
  const other='5511998765433@s.whatsapp.net',started=deferred(),finish=deferred();
  let delay=false;
  const browser=await createBrowser({historyRecords:[audio(),audio('audio-1',other)],chatRecords:[
    {jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:other,name:'Bruno',unread:0,status:'open',labels:[]}
  ],onTranscriptions:async({method,jid:chat,input})=>{
    if(method==='POST') return job(input);
    if(chat===jid && delay) {started.resolve();await finish.promise;return [job({status:'completed',text:'Texto antigo da Ana'})];}
    return chat===jid?[job()]:[];
  }});
  delay=true;
  const polling=browser.pollTranscriptions();await started.promise;
  await browser.selectChat(1);finish.resolve();await polling;
  assert.doesNotMatch(browser.get('messages').textContent,/Texto antigo da Ana/);
  assert.equal(findClass(browser.get('messages'),'transcription-provider').value,'whisper');
});

test('falha de transcrição exibe erro e novo clique solicita retry explícito',async()=>{
  const browser=await createBrowser({historyRecords:[audio()],onTranscriptions:async({method,input})=>method==='POST'?job({...input,status:'queued',updatedAt:'2026-10-28T12:01:00.000Z'}):[job({status:'failed',error:'Whisper indisponível'})]});
  const row=browser.get('messages').children[0],button=findClass(row,'transcribe-button');
  assert.match(row.textContent,/Whisper indisponível/);
  assert.equal(button.textContent,'Tentar novamente');
  await button.emit('click');
  assert.deepEqual(browser.requests.find(request=>request.path==='/api/transcriptions' && request.method==='POST').input,{jid,messageId:'audio-1',provider:'whisper',retry:true});
});

test('IA exige configuração, informa envio para OpenAI e só envia ao clicar após salvar chave',async()=>{
  const browser=await createBrowser({historyRecords:[audio()],onTranscriptions:async({method,input})=>method==='POST'?job(input):[]});
  const row=browser.get('messages').children[0],provider=findClass(row,'transcription-provider');
  assert.ok(provider,'Falta o seletor de provedor.');
  provider.value='ai';await provider.emit('change');
  assert.equal(findClass(row,'transcription-disclosure').hidden,false);
  assert.match(findClass(row,'transcription-disclosure').textContent,/enviado.*OpenAI/);
  assert.equal(browser.get('transcription-dialog').open,true);
  assert.match(browser.get('transcription-settings-status').textContent,/chave/);
  assert.equal(browser.requests.filter(request=>request.path==='/api/transcriptions' && request.method==='POST').length,0);
  browser.get('transcription-model').value='small';browser.get('transcription-language').value='auto';browser.get('transcription-api-key').value='private-test-key';
  await browser.get('transcription-form').emit('submit',{submitter:browser.get('save-transcription-settings')});
  assert.equal(browser.get('transcription-api-key').value,'','A chave não pode ficar refletida no formulário.');
  assert.equal(browser.get('transcription-dialog').open,false);
  await findClass(row,'transcribe-button').emit('click');
  assert.deepEqual(browser.requests.find(request=>request.path==='/api/transcriptions' && request.method==='POST').input,{jid,messageId:'audio-1',provider:'ai'});
  await browser.get('transcription-settings').emit('click');
  assert.equal(browser.get('transcription-api-key').value,'');
  await browser.get('remove-transcription-key').emit('click');
  assert.equal(browser.requests.filter(request=>request.path==='/api/transcription/settings' && request.method==='PATCH').at(-1).input.removeAiKey,true);
  assert.match(browser.get('transcription-key-status').textContent,/Nenhuma chave/);
});

test('cartão de áudio carrega por clique, mostra tempo e velocidade e mantém o player após novas mensagens',async()=>{
  const browser=await createBrowser({historyRecords:[audio()]});
  const card=findClass(browser.get('messages'),'audio-card');
  assert.ok(card,'O áudio precisa de um cartão com controles claros.');
  const player=descendants(card).find(child=>child.tagName==='AUDIO');
  assert.equal(browser.requests.some(request=>request.path==='/api/media'),false);
  assert.equal(player.preload,'none');
  assert.equal(findClass(card,'audio-speed').children.length,3,'Velocidades 1×, 1,5× e 2× lado a lado.');
  await findClass(card,'audio-play').emit('click');
  assert.equal(browser.requests.filter(request=>request.path==='/api/media').length,1);
  assert.match(player.src,/^blob:/);
  assert.notEqual(player.autoplay,true,'Carregar o áudio não deve iniciar a reprodução automaticamente.');
  player.currentTime=12;player.duration=95;await player.emit('timeupdate');
  assert.equal(findClass(card,'audio-time').textContent,'0:12 / 1:35');
  const rate=findClass(card,'audio-speed').children[1];await rate.emit('click');
  assert.equal(player.playbackRate,1.5);
  browser.appendMessages(1);await browser.poll();
  assert.equal(descendants(browser.get('messages')).find(child=>child.tagName==='AUDIO'),player,'Uma mensagem nova interrompeu o áudio.');
  assert.equal(player.currentTime,12);
});

test('áudio grande não carrega sozinho e mostra o tamanho',async()=>{
  const browser=await createBrowser({historyRecords:[{...audio(),bytes:5*1048576}]});
  const card=findClass(browser.get('messages'),'audio-card');
  assert.ok(findClass(card,'audio-note').textContent.includes('Áudio grande (5,0 MB)'));
  assert.equal(browser.requests.some(request=>request.path==='/api/media'),false);
  await findClass(card,'audio-play').emit('click');
  assert.equal(browser.requests.filter(request=>request.path==='/api/media').length,1);
});

test('erro ao carregar áudio permanece no cartão e só tenta novamente por clique',async()=>{
  const browser=await createBrowser({historyRecords:[audio()],onMedia:async()=>{throw new Error('Áudio não disponível no conector.');}});
  const card=findClass(browser.get('messages'),'audio-card');assert.ok(card);
  await findClass(card,'audio-play').emit('click');
  assert.match(card.textContent,/Áudio não disponível/);
  await browser.poll();
  assert.equal(browser.requests.filter(request=>request.path==='/api/media').length,1);
  assert.equal(findClass(card,'audio-play').disabled,false);
});

test('atualizar nomes preserva seleção, telefone conhecido de LID, rascunho e anexo',async()=>{
  const chats=[{jid:'999999@lid',phone:'5511998765432',name:'Contato',unread:0,status:'open',labels:[]}];
  const browser=await createBrowser({chatRecords:chats,onContactsSync:async input=>{
    assert.deepEqual(input,{});chats[0]={...chats[0],name:'Ana da agenda',nameSource:'name'};return {total:1,named:1,lastSyncAt:'2026-10-28T13:00:00Z'};
  }});
  browser.get('message-text').value='Rascunho preservado';await browser.get('message-text').emit('input');
  browser.get('attachment').files=[{name:'imagem.png',size:5,type:'image/png'}];await browser.get('attachment').emit('change');
  await browser.get('sync-contact-names').emit('click');
  assert.equal(browser.requests.filter(request=>request.path==='/api/contacts/sync').length,1);
  assert.equal(browser.get('contact-name').textContent,'Ana da agenda');
  assert.equal(browser.get('contact-phone').textContent,'+55 11 99876-5432');
  assert.equal(browser.get('message-text').value,'Rascunho preservado');
  assert.equal(browser.get('attachment-info').hidden,false);
  assert.match(browser.get('chat-list').textContent,/Ana da agenda/);
  browser.get('search').value='11998765432';await browser.get('search').emit('input');
  assert.equal(browser.get('chat-list').children[0].tagName,'BUTTON','O telefone conhecido deve encontrar a conversa LID.');
});

test('menu copia texto seguro e usa a transcrição quando o áudio não tem legenda',async()=>{
  const text='<img src=x onerror=alert(1)> Texto literal';
  const browser=await createBrowser({historyRecords:[{...message(1),text},audio()],onTranscriptions:async()=>[job({status:'completed',text:'Texto da transcrição'})]});
  const rows=browser.get('messages').children;
  const copy=findClass(rows[0],'message-copy');assert.ok(copy,'Falta a ação Copiar texto.');
  await copy.emit('click');await findClass(rows[1],'message-copy').emit('click');
  assert.deepEqual(browser.copied,[text,'Texto da transcrição']);
  assert.equal(descendants(rows[0]).some(child=>child.tagName==='IMG'),false);
});

test('encaminhar exige destinatário e confirmação, captura a origem e não envia o rascunho',async()=>{
  const other='5511998765433@s.whatsapp.net',group='123456@g.us';
  const browser=await createBrowser({historyRecords:[message(1)],chatRecords:[
    {jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:other,name:'Bruno',unread:0,status:'open',labels:[]},{jid:group,name:'Grupo',unread:0,status:'open',labels:[]}
  ]});
  const action=findClass(browser.get('messages'),'message-forward');assert.ok(action,'Falta a ação Encaminhar.');await action.emit('click');
  assert.equal(browser.get('forward-dialog').open,true);
  assert.match(browser.get('forward-preview').textContent,/Mensagem 1/);
  assert.equal(browser.get('forward-confirm').disabled,true);
  assert.equal(browser.requests.some(request=>request.path==='/api/forward'),false);
  browser.get('forward-search').value='Bruno';await browser.get('forward-search').emit('input');
  assert.equal(browser.get('forward-destinations').children.length,1);
  await browser.get('forward-destinations').children[0].emit('click');
  assert.equal(browser.requests.some(request=>request.path==='/api/forward'),false);
  await browser.selectChat(1);browser.get('message-text').value='Rascunho do Bruno';await browser.get('message-text').emit('input');
  await browser.get('forward-confirm').emit('click');
  const request=browser.requests.find(request=>request.path==='/api/forward');
  assert.deepEqual(request.input,{sourceJid:jid,messageId:'1',targetJid:other,requestId:'frontend-request-1'});
  assert.equal(browser.get('message-text').value,'Rascunho do Bruno');
  assert.equal(browser.get('forward-dialog').open,false);
  await browser.get('forward-confirm').emit('click');
  assert.equal(browser.requests.filter(request=>request.path==='/api/forward').length,1,'Uma confirmação antiga não pode encaminhar de novo após fechar.');
});

test('encaminhamento bloqueia duplo clique e conserva requestId para repetição explícita após falha',async()=>{
  const other='5511998765433@s.whatsapp.net',started=deferred(),release=deferred();let attempts=0;
  const browser=await createBrowser({historyRecords:[message(1)],chatRecords:[
    {jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:other,name:'Bruno',unread:0,status:'open',labels:[]}
  ],onForward:async()=>{attempts++;if(attempts===1) {started.resolve();await release.promise;throw new Error('Tempo esgotado');}return message(2);}});
  browser.get('message-text').value='Não apagar';await browser.get('message-text').emit('input');
  const action=findClass(browser.get('messages'),'message-forward');assert.ok(action);await action.emit('click');
  const destinations=browser.get('forward-destinations');
  await destinations.children.find(button=>button.textContent.includes('Bruno')).emit('click');
  const first=browser.get('forward-confirm').emit('click');await started.promise;
  await browser.get('forward-confirm').emit('click');
  assert.equal(attempts,1);release.resolve();await first;
  assert.equal(browser.get('forward-dialog').open,true);
  assert.match(browser.get('forward-error').textContent,/Tempo esgotado/);
  assert.equal(browser.get('message-text').value,'Não apagar');
  await browser.poll();assert.equal(attempts,1,'O polling repetiu o encaminhamento sem confirmação.');
  await browser.get('forward-confirm').emit('click');
  const inputs=browser.requests.filter(request=>request.path==='/api/forward').map(request=>request.input);
  assert.equal(inputs[0].requestId,inputs[1].requestId);
});

test('retornar ao destinatário após resultado incerto conserva a solicitação original',async()=>{
  const bruno='5511998765433@s.whatsapp.net',carla='5511998765434@s.whatsapp.net';
  const browser=await createBrowser({historyRecords:[message(1)],chatRecords:[
    {jid,name:'Ana',unread:0,status:'open',labels:[]},{jid:bruno,name:'Bruno',unread:0,status:'open',labels:[]},{jid:carla,name:'Carla',unread:0,status:'open',labels:[]}
  ],onForward:async()=>{throw new Error('Tempo esgotado: resultado incerto');}});
  await findClass(browser.get('messages'),'message-forward').emit('click');
  const choose=async name=>browser.get('forward-destinations').children.find(button=>button.textContent.includes(name)).emit('click');
  await choose('Bruno');await browser.get('forward-confirm').emit('click');
  await choose('Carla');await browser.get('forward-confirm').emit('click');
  await choose('Bruno');await browser.get('forward-confirm').emit('click');
  const inputs=browser.requests.filter(request=>request.path==='/api/forward').map(request=>request.input);
  assert.notEqual(inputs[0].requestId,inputs[1].requestId,'Destinatários diferentes devem ter solicitações separadas.');
  assert.equal(inputs[0].requestId,inputs[2].requestId,'Voltar ao destinatário original não pode contornar a proteção contra duplicados.');
});

test('mensagem marcada como incompatível mantém encaminhamento indisponível',async()=>{
  const browser=await createBrowser({historyRecords:[{...message(1),text:'Contato compartilhado',canForward:false}]});
  const forward=findClass(browser.get('messages'),'message-forward');assert.ok(forward);
  assert.equal(forward.disabled,true);
  await forward.emit('click');
  assert.equal(browser.get('forward-dialog').open,false,'Uma mensagem incompatível não pode abrir o fluxo de envio.');
  assert.equal(browser.requests.some(request=>request.path==='/api/forward'),false);
});

test('áudio sem transcrição mantém Copiar texto indisponível até o resultado chegar',async()=>{
  let saved=[job()];
  const browser=await createBrowser({historyRecords:[audio()],onTranscriptions:async()=>saved});
  const copy=findClass(browser.get('messages'),'message-copy');assert.equal(copy.disabled,true);
  saved=[job({status:'completed',text:'Resultado novo',updatedAt:'2026-10-28T12:02:00Z'})];await browser.pollTranscriptions();
  assert.equal(copy.disabled,false);await copy.emit('click');assert.deepEqual(browser.copied,['Resultado novo']);
});

test('ponte de agendamento preserva edição posterior e limpa apenas o rascunho agendado sem alterações',async()=>{
  let hooks;const selections=[],refreshes=[];
  const browser=await createBrowser({scheduleModule:{init:value=>{hooks=value;},onSelectChat:chat=>selections.push(chat),onChats:chats=>refreshes.push(chats)}});
  assert.ok(hooks);assert.equal(hooks.getSelected().jid,jid);assert.equal(refreshes.length,1);
  browser.get('message-text').value='Agendar';await browser.get('message-text').emit('input');
  const snapshot=hooks.getDraft();
  browser.get('message-text').value='Próximo rascunho';await browser.get('message-text').emit('input');
  hooks.onScheduled({jid},snapshot);assert.equal(browser.get('message-text').value,'Próximo rascunho');
  const current=hooks.getDraft();hooks.onScheduled({jid},current);assert.equal(browser.get('message-text').value,'');
  await browser.get('back-to-chats').emit('click');assert.equal(selections.at(-1),null);
});

test('produto da lista entra no editor da conversa sem enviar e os contadores usam dados reais',async()=>{
  const sends=[];
  const product={id:'11111111-1111-1111-1111-111111111111',name:'Produto A',sku:'PA-1',price:150,warranty:'12 meses',category:'Sistemas',kind:'produto',discountPercent:0,stock:null,active:true,freeShipping:false,finalPrice:150,images:[],description:'',message:'*Produto A*\nPreço: R$ 150,00\nGarantia: 12 meses'};
  const browser=await createBrowser({withPages:true,catalog:[product],kbDocs:[{id:'22222222-2222-2222-2222-222222222222',name:'catalogo.txt',type:'txt',size:200,chunks:1,createdAt:'2026-10-29T10:00:00Z'}],onSend:async input=>sends.push(input)});
  await settle();
  assert.equal(browser.get('notice').textContent,'');
  assert.equal(browser.get('metric-products').textContent,'1');
  assert.equal(browser.get('metric-docs').textContent,'1');
  assert.equal(browser.get('status-ai').textContent,'Não configurada');
  const entry=browser.get('panel-products').children[0];
  assert.match(entry.textContent,/Produto A/);
  assert.equal(entry.disabled,false,'Com uma conversa aberta o produto deve poder ser usado.');
  browser.get('message-text').value='Olá!';
  await entry.emit('click');await settle();
  assert.equal(browser.get('message-text').value,'Olá!\n'+product.message);
  assert.equal(sends.length,0,'Usar o produto apenas preenche o editor.');
});
