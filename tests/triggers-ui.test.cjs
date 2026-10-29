const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const file=path.join(__dirname,'../public/triggers.js');
function browser({rules=[],enabled=false,save}={}) {
  const nodes=new Map(),requests=[],notices=[];let settings={enabled,enabledSince:null,cooldownSeconds:60,rules};
  function element(tag='div') {
    let text='',id='';const listeners=new Map(),attributes={};
    const node={tagName:tag.toUpperCase(),children:[],value:'',disabled:false,hidden:false,open:false,checked:false,dataset:{},className:'',parentNode:null,files:[],
      get id(){return id;},set id(value){id=value;nodes.set(value,this);},
      get textContent(){return text+this.children.map(child=>child.textContent||'').join('');},set textContent(value){text=String(value);this.children=[];},
      get nextSibling(){const list=this.parentNode?.children||[];return list[list.indexOf(this)+1]||null;},
      append(...items){for(let item of items){if(typeof item==='string') item={textContent:item,children:[]};item.parentNode=this;this.children.push(item);}},
      insertBefore(item,before){const index=this.children.indexOf(before);if(index<0)this.append(item);else{item.parentNode=this;this.children.splice(index,0,item);}},
      replaceChildren(...items){text='';this.children=[];this.append(...items);},
      addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
      async emit(type,event={}){for(const fn of listeners.get(type)||[])await fn({preventDefault(){},target:this,...event});},
      setAttribute(name,value){attributes[name]=value;},getAttribute:name=>attributes[name],removeAttribute(name){delete attributes[name];},
      focus(){},click(){return this.emit('click');},showModal(){this.open=true;},close(){this.open=false;return this.emit('close');},
      querySelector(selector){return walk(this).find(child=>selector.startsWith('.')?child.className?.split(' ').includes(selector.slice(1)):child.id===selector.slice(1));},
      classList:{toggle(){},add(){},remove(){}}
    };return node;
  }
  function walk(node){return node.children.flatMap(child=>[child,...walk(child)]);}
  const body=element('body'),nav=element('nav'),automation=element('button');automation.id='nav-automation';nav.append(automation);body.append(nav);
  const document={body,createElement:element,createElementNS:element,getElementById:id=>nodes.get(id)||null,querySelector:selector=>selector==='.main-nav'?nav:null};
  const api=async(route,method='GET',input)=>{
    requests.push({route,method,input});
    if(route==='/triggers'&&method==='GET')return structuredClone(settings);
    if(route==='/triggers'&&method==='PUT'){if(save)await save(input);settings={...settings,...structuredClone(input)};settings.rules=settings.rules.map((rule,index)=>({...rule,id:rule.id||'rule-'+index}));return structuredClone(settings);}
    if(route==='/triggers/executions')return [];
    if(route==='/triggers/simulate')return {matched:settings.rules.length>0,rule:settings.rules[0]||null,messages:settings.rules[0]?.messages||[]};
    throw Error('Unexpected route '+route);
  };
  const context={document,Date,Intl,Map,Set,console,FileReader:class {readAsDataURL(file){this.result='data:'+file.type+';base64,aGVsbG8=';this.onload();}}};
  if(fs.existsSync(file))vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
  assert.equal(typeof context.WhatsAppTriggers?.init,'function','trigger module exposes init');
  context.WhatsAppTriggers.init({api,notice:(...args)=>notices.push(args),getChats:()=>[],getSelected:()=>null});
  return {feature:context.WhatsAppTriggers,get:id=>nodes.get(id),requests,notices,walk,nav};
}
const sample={id:'r1',name:'Fora do horário',enabled:true,type:'absence',keywords:[],match:'contains',inactiveDays:null,delaySeconds:3,timezone:'America/Sao_Paulo',schedule:{days:[1,2,3,4,5],start:'09:00',end:'18:00'},messages:[{type:'text',text:'Voltamos amanhã.'}]};
function action(b,holder,text){return b.walk(b.get(holder)).find(node=>node.tagName==='BUTTON'&&node.textContent===text);}
async function createRule(b){await b.get('nav-triggers').emit('click');await b.get('trigger-new').emit('click');b.get('trigger-name').value='Boas-vindas';b.get('trigger-message-text-0').value='Olá! Como posso ajudar?';await b.get('trigger-message-text-0').emit('input');}

test('init injects the trigger entry point without reading or enabling automations',()=>{
  const b=browser();assert.ok(b.get('nav-triggers'));assert.equal(b.nav.children[1].id,'nav-triggers');assert.equal(b.requests.length,0);assert.equal(b.get('trigger-editor-dialog').open,false);
});
test('saving a first-contact trigger preserves disabled master switch',async()=>{
  const b=browser();await createRule(b);await b.get('trigger-form').emit('submit');
  const request=b.requests.find(item=>item.method==='PUT');assert.deepEqual(Object.keys(request.input),['rules']);assert.equal(request.input.rules[0].type,'first_contact');assert.equal(request.input.rules[0].messages[0].text,'Olá! Como posso ajudar?');assert.equal(b.get('triggers-enabled').checked,false);assert.equal(b.get('trigger-editor-dialog').open,false);
});
test('cancel and invalid response never write settings',async()=>{
  const b=browser();await b.get('nav-triggers').emit('click');await b.get('trigger-new').emit('click');b.get('trigger-name').value='Sem resposta';await b.get('trigger-form').emit('submit');
  assert.match(b.get('trigger-form-status').textContent,/mensagem|resposta/i);assert.equal(b.requests.filter(item=>item.method==='PUT').length,0);await b.get('trigger-cancel').emit('click');assert.equal(b.get('trigger-editor-dialog').open,false);
});
test('absence hours, inactivity and delayed responses serialize with explicit days',async()=>{
  const b=browser();await createRule(b);b.get('trigger-type').value='absence';await b.get('trigger-type').emit('change');b.get('trigger-delay').value='8';b.get('trigger-inactivity-enabled').checked=true;await b.get('trigger-inactivity-enabled').emit('change');b.get('trigger-inactive-days').value='5';b.get('trigger-hours-start').value='08:30';b.get('trigger-hours-end').value='17:15';b.get('trigger-day-1').checked=false;
  await b.get('trigger-form').emit('submit');const rule=b.requests.find(item=>item.method==='PUT').input.rules[0];assert.equal(rule.type,'absence');assert.equal(rule.delaySeconds,8);assert.equal(rule.inactiveDays,5);assert.equal(rule.schedule.start,'08:30');assert.deepEqual([...rule.schedule.days],[2,3,4,5]);
});
test('keyword triggers validate words and save ordered text and poll messages',async()=>{
  const b=browser();await createRule(b);b.get('trigger-type').value='keyword';await b.get('trigger-type').emit('change');await b.get('trigger-form').emit('submit');assert.match(b.get('trigger-form-status').textContent,/palavra/i);
  b.get('trigger-keywords').value='preço, catálogo';b.get('trigger-match').value='word';await b.get('trigger-add-message').emit('click');await b.get('trigger-message-poll-1').emit('click');b.get('trigger-poll-name-1').value='Qual serviço?';await b.get('trigger-poll-name-1').emit('input');b.get('trigger-poll-options-1').value='Entrega\nRetirada';await b.get('trigger-poll-options-1').emit('input');await b.get('trigger-form').emit('submit');
  const rule=b.requests.find(item=>item.method==='PUT').input.rules[0];assert.deepEqual([...rule.keywords],['preço','catálogo']);assert.equal(rule.match,'word');assert.deepEqual([...rule.messages[1].options],['Entrega','Retirada']);assert.equal(rule.messages[1].selectableCount,1);
});
test('safe saved names render as text and editing preserves other rules',async()=>{
  const b=browser({rules:[sample,{...sample,id:'r2',name:'<img src=x onerror=alert(1)>'}]});await b.get('nav-triggers').emit('click');assert.match(b.get('triggers-list').textContent,/<img src=x onerror=alert\(1\)>/);await action(b,'triggers-list','Editar').emit('click');b.get('trigger-name').value='Revisado';await b.get('trigger-form').emit('submit');
  const rules=b.requests.find(item=>item.method==='PUT').input.rules;assert.equal(rules.length,2);assert.equal(rules[0].id,'r1');assert.equal(rules[0].name,'Revisado');assert.equal(rules[1].id,'r2');
});
test('failed save keeps the editor open and duplicate submits are blocked',async()=>{
  let reject;const b=browser({save:()=>new Promise((resolve,no)=>{reject=no;})});await createRule(b);const first=b.get('trigger-form').emit('submit');await b.get('trigger-form').emit('submit');assert.equal(b.requests.filter(item=>item.method==='PUT').length,1);reject(Error('Falha ao salvar'));await first;assert.equal(b.get('trigger-editor-dialog').open,true);assert.equal(b.get('trigger-name').value,'Boas-vindas');assert.match(b.get('trigger-form-status').textContent,/Falha ao salvar/);
});
test('audio files produce real media messages, simulation uses only the dry-run endpoint',async()=>{
  const b=browser({rules:[sample]});await createRule(b);await b.get('trigger-message-audio-0').emit('click');b.get('trigger-media-file-0').files=[{name:'saudacao.ogg',type:'audio/ogg',size:5}];await b.get('trigger-media-file-0').emit('change');await b.get('trigger-form').emit('submit');const rule=b.requests.find(item=>item.method==='PUT').input.rules.at(-1);assert.equal(rule.messages[0].type,'audio');assert.equal(rule.messages[0].base64,'aGVsbG8=');assert.equal(rule.messages[0].fileName,'saudacao.ogg');
  b.get('trigger-test-text').value='oi';await b.get('trigger-test-form').emit('submit');assert.equal(b.requests.at(-1).route,'/triggers/simulate');assert.match(b.get('trigger-test-result').textContent,/Fora do horário/);assert.equal(b.requests.some(item=>/send/.test(item.route)),false);
});
