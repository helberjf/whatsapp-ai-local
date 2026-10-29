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
    scrollHeight:100,scrollTop:0,clientHeight:100,classList:{toggle(){}},
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
    setAttribute(){},removeAttribute(){},scrollIntoView(){},focus(){},
    showModal() {this.open=true;},close() {this.open=false;}
  };
}

function message(number) {
  return {
    id:String(number),jid,fromMe:true,text:'Mensagem '+number,type:'text',
    timestamp:1793200000000+number*1000,status:'DELIVERY_ACK',
    mimeType:null,fileName:null,key:{id:String(number),remoteJid:jid,fromMe:true}
  };
}

async function createBrowser({count=0,onSend=async()=>{},onMessages=async()=>{},FileReader,chatRecords,templates=[],historyRecords,onTranscriptions=async()=>[],onTranscriptionSettings=async()=>{},aiConfigured=false}={}) {
  const nodes=new Map(),intervals=[],requests=[],copied=[];
  let history=historyRecords || Array.from({length:count},(_,index)=>message(index+1));
  let transcriptionSettings={defaultProvider:'whisper',whisperModel:'base',language:'pt',aiConfigured,aiModel:'gpt-transcribe'};
  const get=id=>{if(!nodes.has(id)) nodes.set(id,element());return nodes.get(id);};
  const document={
    getElementById:get,querySelector:()=>({content:'test-session'}),querySelectorAll:()=>[],
    createElement:element,createDocumentFragment:()=>element('fragment',true),
    addEventListener(){},visibilityState:'visible'
  };
  async function fetchLocal(address,options={}) {
    const url=new URL(address,'http://127.0.0.1:8766');
    const input=options.body?JSON.parse(options.body):undefined;
    requests.push({path:url.pathname,jid:url.searchParams.get('jid'),method:options.method||'GET',input});
    let output;
    if(url.pathname==='/api/settings') output={templates};
    else if(url.pathname==='/api/transcription/settings') {
      const result=await onTranscriptionSettings({method:options.method||'GET',input});
      if(options.method==='PATCH') transcriptionSettings={...transcriptionSettings,...(input.whisperModel?{whisperModel:input.whisperModel}:{}),...(input.language?{language:input.language}:{}),...(input.aiApiKey?{aiConfigured:true}:{}),...(input.removeAiKey?{aiConfigured:false}:{})};
      output=result || transcriptionSettings;
    }
    else if(url.pathname==='/api/transcriptions') output=await onTranscriptions({jid:url.searchParams.get('jid'),method:options.method||'GET',input});
    else if(url.pathname==='/api/connection') output={state:'connected',reachable:true,exists:true,phone:'5511000000000',instanceName:'teste'};
    else if(url.pathname==='/api/chats') output=chatRecords || [{jid,name:'Ana',unread:0,status:'open',labels:[],notes:[],lastMessage:history.at(-1)||null}];
    else if(url.pathname==='/api/contact') output={status:'open',labels:[],notes:[]};
    else if(url.pathname==='/api/messages') {
      const page=Number(url.searchParams.get('page')||1);
      const descending=history.filter(record=>record.jid===url.searchParams.get('jid')).reverse();
      output={messages:descending.slice((page-1)*50,page*50).reverse(),page,pages:Math.max(1,Math.ceil(history.length/50)),total:history.length};
      await onMessages({page});
    } else if(['/api/send','/api/send-media'].includes(url.pathname)) {
      const input=JSON.parse(options.body);
      await onSend(input);
      output={...message(history.length+1),text:input.text || input.caption || ''};
    } else if(url.pathname==='/api/read') output={read:true};
    else if(url.pathname==='/api/media') output={base64:'aGVsbG8=',mimeType:'audio/ogg',fileName:'audio.ogg'};
    else throw new Error('Requisição inesperada no teste: '+address);
    return {ok:true,json:async()=>output};
  }
  vm.runInNewContext(fs.readFileSync(appFile,'utf8'),{
    document,fetch:fetchLocal,Intl,Date,Map,Set,URL,URLSearchParams,AbortSignal,FileReader,Blob,Uint8Array,atob,
    navigator:{clipboard:{writeText:async text=>{copied.push(text);}}},
    crypto:{randomUUID:()=> 'frontend-request-001'},
    setInterval(callback,delay) {intervals.push({callback,delay});return intervals.length;},
    setTimeout,clearTimeout,location:{search:''},matchMedia:()=>({matches:false})
  },{filename:appFile});
  await settle();
  assert.equal(get('notice').textContent,'','A inicialização do app não deve falhar.');
  assert.equal(get('chat-list').children.length,chatRecords?.length || 1);
  await get('chat-list').children[0].emit('click');
  assert.equal(get('notice').textContent,'','A seleção da conversa não deve falhar.');
  return {
    get,requests,copied,
    appendMessages(amount) {
      const start=history.length;
      history.push(...Array.from({length:amount},(_,index)=>message(start+index+1)));
    },
    async poll() {await intervals.find(interval=>interval.delay===4000).callback();},
    async pollTranscriptions() {const interval=intervals.find(interval=>interval.delay!==4000);assert.ok(interval,'A transcrição precisa de polling independente.');await interval.callback();},
    async selectChat(index) {await get('chat-list').children[index].emit('click');},
    renderedMessages() {
      return get('messages').children.filter(row=>row.tagName==='ARTICLE')
        .map(row=>row.children.find(child=>child.tagName==='P')?.textContent);
    }
  };
}

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

test('dashboard mostra quatro contagens reais e navegação filtra os atendimentos',async()=>{
  const chats=[
    {jid,name:'Ana',unread:0,status:'open',labels:[],lastMessage:null},
    {jid:'5511998765433@s.whatsapp.net',name:'Bruno',unread:2,status:'pending',labels:['Retornar'],lastMessage:null},
    {jid:'5511998765434@s.whatsapp.net',name:'Carla',unread:1,status:'closed',labels:[],lastMessage:null},
    {jid:'5511998765435@s.whatsapp.net',name:'Daniel',unread:0,status:'open',labels:[],lastMessage:null}
  ];
  const browser=await createBrowser({chatRecords:chats});
  assert.equal(browser.get('metric-total').textContent,'4');
  assert.equal(browser.get('metric-unread').textContent,'2');
  assert.equal(browser.get('metric-pending').textContent,'1');
  assert.equal(browser.get('metric-closed').textContent,'1');
  assert.equal(browser.get('connected-phone').textContent,'+55 11 00000-0000');
  await browser.get('nav-pending').emit('click');
  assert.equal(browser.get('chat-list').children.length,1);
  assert.match(browser.get('chat-list').textContent,/Bruno/);
  await browser.get('metric-unread-button').emit('click');
  assert.equal(browser.get('chat-list').children.length,2);
  await browser.get('nav-overview').emit('click');
  assert.equal(browser.get('chat-list').children.length,4);
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
  await row.children[0].emit('click'); // Abre o player local.
  row=browser.get('messages').children[0];
  const player=row.children.find(child=>child.tagName==='AUDIO');
  assert.ok(player,'O player precisa continuar funcionando junto à transcrição.');
  await findClass(row,'transcribe-button').emit('click');
  saved=[job({status:'completed',text:'Olá, podemos conversar amanhã?',updatedAt:'2026-10-28T12:01:00.000Z'})];
  await browser.pollTranscriptions();await browser.poll();
  assert.equal(browser.get('messages').children[0],row,'Atualizar transcrição não deve recriar a mensagem.');
  assert.equal(row.children.find(child=>child.tagName==='AUDIO'),player,'O polling interrompeu o player.');
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
