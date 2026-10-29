const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const file=path.join(__dirname,'../public/schedule.js');
const jid='5511998765432@s.whatsapp.net';
function browser({jobs=[],create}={}) {
  const nodes=new Map(),requests=[],notices=[],scheduled=[],timers=new Map();let timerId=0,uuid=0;
  function element(tag='div') {
    let text='',id='';const listeners=new Map();
    const node={tagName:tag.toUpperCase(),children:[],value:'',disabled:false,hidden:false,open:false,dataset:{},className:'',parentNode:null,
      get id(){return id;},set id(value){id=value;nodes.set(value,this);},
      get textContent(){return text+this.children.map(child=>child.textContent).join('');},set textContent(value){text=String(value);this.children=[];},
      append(...items){for(const item of items){item.parentNode=this;this.children.push(item);}},
      insertBefore(item,before){const index=this.children.indexOf(before);if(index<0) this.append(item);else{item.parentNode=this;this.children.splice(index,0,item);}},
      replaceChildren(...items){text='';this.children=[];this.append(...items);},
      addEventListener(type,fn){if(!listeners.has(type)) listeners.set(type,[]);listeners.get(type).push(fn);},
      async emit(type,event={}){for(const fn of listeners.get(type)||[]) await fn({preventDefault(){},target:this,...event});},
      setAttribute(){},focus(){},showModal(){this.open=true;},close(){this.open=false;return this.emit('close');},
      querySelector(selector){return walk(this).find(child=>selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.id===selector.slice(1));},
      classList:{toggle(){},add(){},remove(){}}
    };return node;
  }
  function walk(node){return node.children.flatMap(child=>[child,...walk(child)]);}
  const body=element('body'),nav=element('nav'),composer=element('form'),quick=element('label'),editor=element();
  composer.id='composer';quick.className='quick-reply';editor.className='composer-editor';composer.append(quick,editor);body.append(nav,composer);
  const document={body,createElement:element,getElementById:id=>nodes.get(id)||null,querySelector:selector=>({'.main-nav':nav,'.quick-reply':quick,'.composer-editor':editor})[selector]||null};
  const chats=[{jid,name:'Ana <script>',phone:'5511998765432'},{jid:'123456789012@lid',name:'Contato LID'},{jid:'123@g.us',name:'Grupo'}];
  let selected=chats[0],draft={text:'Mensagem do editor',hasAttachment:false,revision:3};
  const api=async(route,method='GET',input)=>{
    requests.push({route,method,input});
    if(method==='GET') return jobs.map(job=>({...job}));
    if(method==='POST' && route==='/scheduled-messages') {if(create) return create(input);const job={id:'job-new',...input,status:'scheduled'};jobs.push(job);return job;}
    const id=decodeURIComponent(route.split('/')[2]),job=jobs.find(item=>item.id===id);
    if(method==='PATCH'){Object.assign(job,input,{status:'scheduled'});return {...job};}
    if(route.endsWith('/cancel')){job.status='cancelled';return {...job};}
    throw Error('Unexpected route '+route);
  };
  const context={document,Date,Intl,Map,Set,console,crypto:{randomUUID:()=>`request-${++uuid}`},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
  if(fs.existsSync(file)) vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
  assert.equal(typeof context.WhatsAppSchedule?.init,'function','scheduler module exposes init');
  context.WhatsAppSchedule.init({api,notice:(...args)=>notices.push(args),getChats:()=>chats,getSelected:()=>selected,getDraft:()=>draft,onScheduled:(...args)=>scheduled.push(args)});
  return {feature:context.WhatsAppSchedule,get:id=>nodes.get(id),requests,notices,scheduled,timers,walk,chats,setDraft:value=>draft=value,setSelected:value=>selected=value};
}
function fill(b,{text='Agendada',recipient=jid,date='2099-11-01T12:30'}={}) {b.get('schedule-recipient').value=recipient;b.get('schedule-text').value=text;b.get('schedule-at').value=date;}
function action(b,text){return b.walk(b.get('schedule-list')).find(node=>node.tagName==='BUTTON' && node.textContent===text);}

test('initialization adds entry points without fetching, scheduling or sending',()=>{
  const b=browser();assert.ok(b.get('nav-schedule'));assert.ok(b.get('schedule-message-button'));assert.equal(b.requests.length,0);assert.equal(b.timers.size,0);
});
test('identificadores privados sem nome continuam distinguíveis na escolha do destinatário',async()=>{
  const b=browser();b.feature.onChats([{jid:'111111111111@lid',name:'111111111111'},{jid:'222222222222@lid',name:'222222222222'}]);await b.get('nav-schedule').emit('click');
  assert.match(b.get('schedule-recipient').textContent,/ID 111111111111/);assert.match(b.get('schedule-recipient').textContent,/ID 222222222222/);assert.doesNotMatch(b.get('schedule-recipient').textContent,/\+111111111111/);
});
test('composer prefill schedules text with local time converted to ISO and original snapshot',async()=>{
  const b=browser();await b.get('schedule-message-button').emit('click');assert.equal(b.get('schedule-dialog').open,true);
  assert.equal(b.get('schedule-text').value,'Mensagem do editor');assert.equal(b.get('schedule-recipient').value,jid);
  b.get('schedule-at').value='2099-11-01T12:30';await b.get('schedule-form').emit('submit');
  const request=b.requests.find(item=>item.method==='POST');assert.equal(request.route,'/scheduled-messages');assert.equal(request.input.scheduledAt,new Date('2099-11-01T12:30').toISOString());
  assert.equal(request.input.text,'Mensagem do editor');assert.equal(b.scheduled.length,1);assert.equal(b.scheduled[0][1].revision,3);assert.equal(b.scheduled[0][1].text,'Mensagem do editor');
});
test('duplicate clicks are blocked and retry keeps request id after a timeout',async()=>{
  let reject;const b=browser({create:()=>new Promise((resolve,no)=>{reject=no;})});await b.get('nav-schedule').emit('click');fill(b);
  const first=b.get('schedule-form').emit('submit');await b.get('schedule-form').emit('submit');assert.equal(b.requests.filter(item=>item.method==='POST').length,1);
  reject(Error('Tempo esgotado'));await first;const firstId=b.requests.find(item=>item.method==='POST').input.requestId;
  const retry=b.get('schedule-form').emit('submit');reject(Error('Tempo esgotado'));await retry;
  assert.equal(b.requests.filter(item=>item.method==='POST')[1].input.requestId,firstId);
  b.get('schedule-text').value='Outra mensagem';const changed=b.get('schedule-form').emit('submit');reject(Error('Tempo esgotado'));await changed;
  assert.notEqual(b.requests.filter(item=>item.method==='POST')[2].input.requestId,firstId);
});
test('list renders contact text safely, filters groups, edits and cancels scheduled jobs',async()=>{
  const b=browser({jobs:[{id:'j1',jid,text:'<img src=x onerror=alert(1)>',scheduledAt:'2099-11-01T12:30:00Z',status:'scheduled'}]});await b.get('nav-schedule').emit('click');
  assert.match(b.get('schedule-list').textContent,/<img src=x onerror=alert\(1\)>/);assert.match(b.get('schedule-list').textContent,/Ana <script>/);
  assert.doesNotMatch(b.get('schedule-recipient').textContent,/Grupo/);await action(b,'Editar').emit('click');fill(b,{text:'Texto revisado'});await b.get('schedule-form').emit('submit');
  assert.equal(b.requests.find(item=>item.method==='PATCH').input.text,'Texto revisado');await action(b,'Cancelar').emit('click');assert.equal(b.requests.at(-1).route,'/scheduled-messages/j1/cancel');
});
test('polling updates only the list and closing stops polling while preserving draft',async()=>{
  const b=browser();await b.get('nav-schedule').emit('click');fill(b,{text:'Rascunho que estou escrevendo'});const tick=[...b.timers.values()][0];b.timers.clear();await tick();
  assert.equal(b.get('schedule-text').value,'Rascunho que estou escrevendo');assert.equal(b.timers.size,1);await b.get('schedule-dialog').close();assert.equal(b.timers.size,0);
  await b.get('nav-schedule').emit('click');assert.equal(b.get('schedule-text').value,'Rascunho que estou escrevendo');
});
test('modified form or attachment never asks app to clear the composer',async()=>{
  const b=browser();b.setDraft({text:'Legenda',hasAttachment:true,revision:4});await b.get('schedule-message-button').emit('click');assert.match(b.get('schedule-attachment-note').textContent,/anexo não será incluído/i);
  fill(b);await b.get('schedule-form').emit('submit');assert.equal(b.scheduled.length,0);
  b.setDraft({text:'Original',hasAttachment:false,revision:5});await b.get('schedule-message-button').emit('click');fill(b,{text:'Alterado no agendamento'});await b.get('schedule-form').emit('submit');assert.equal(b.scheduled.length,0);
});
test('uncertain jobs offer check-chat guidance without edit, cancel or retry actions',async()=>{
  const b=browser({jobs:[{id:'j1',jid:'123456789012@lid',text:'Olá',scheduledAt:'2099-11-01T12:30:00Z',status:'uncertain'}]});await b.get('nav-schedule').emit('click');
  assert.match(b.get('schedule-list').textContent,/Confira a conversa/i);assert.doesNotMatch(b.get('schedule-list').textContent,/\+123456789012/);assert.equal(action(b,'Editar'),undefined);assert.equal(action(b,'Cancelar'),undefined);
});
test('new programming explicitly resets the form and chat changes preserve independent drafts',async()=>{
  const b=browser();await b.get('nav-schedule').emit('click');fill(b,{text:'Rascunho da lista'});await b.get('schedule-dialog').close();
  await b.get('schedule-message-button').emit('click');fill(b,{text:'Rascunho de Ana'});await b.get('schedule-dialog').close();
  b.setSelected(b.chats[1]);await b.get('schedule-message-button').emit('click');assert.equal(b.get('schedule-recipient').value,b.chats[1].jid);
  await b.get('schedule-dialog').close();b.setSelected(b.chats[0]);await b.get('schedule-message-button').emit('click');assert.equal(b.get('schedule-text').value,'Rascunho de Ana');
  await b.get('schedule-dialog').close();await b.get('nav-schedule').emit('click');assert.equal(b.get('schedule-text').value,'Rascunho da lista');
  await b.get('schedule-new').emit('click');assert.equal(b.get('schedule-text').value,'');assert.equal(b.get('schedule-recipient').value,'');assert.equal(b.get('schedule-at').value,'');
});
test('polling a sending status blocks stale edit form from making a mutation',async()=>{
  const jobs=[{id:'j1',jid,text:'Olá',scheduledAt:'2099-11-01T12:30:00Z',status:'scheduled'}],b=browser({jobs});await b.get('nav-schedule').emit('click');await action(b,'Editar').emit('click');
  jobs[0].status='sending';const tick=[...b.timers.values()][0];b.timers.clear();await tick();fill(b);await b.get('schedule-form').emit('submit');
  assert.equal(b.requests.filter(item=>item.method!=='GET').length,0);assert.match(b.get('schedule-form-status').textContent,/não pode mais ser editada/i);
});
