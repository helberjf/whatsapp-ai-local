const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function browser({audience='classified',enabled=false,save}={}) {
  const nodes=new Map(),requests=[],prompts=[];let settings={audience,enabled,rules:[],counts:{draft:0,auto:0},log:[],ai:true};
  function element(tag='div',className='',text) {
    let id='',ownText=text||'';const listeners=new Map();
    return {tagName:tag.toUpperCase(),className,children:[],value:'',checked:false,disabled:false,hidden:false,parentNode:null,dataset:{},
      get id(){return id;},set id(value){id=value;nodes.set(id,this);},
      get textContent(){return ownText+this.children.map(child=>child.textContent||'').join('');},set textContent(value){ownText=String(value);this.children=[];},
      append(...values){for(let value of values){if(typeof value==='string')value={textContent:value};value.parentNode=this;this.children.push(value);}},
      insertBefore(item,before){const index=this.children.indexOf(before);if(index<0)this.append(item);else{item.parentNode=this;this.children.splice(index,0,item);}},
      replaceChildren(...values){ownText='';this.children=[];this.append(...values);},
      addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
      async emit(type,event={}){for(const fn of listeners.get(type)||[])await fn({preventDefault(){},target:this,...event});},
      setAttribute(){},classList:{toggle(){}},focus(){}
    };
  }
  const get=id=>{if(!nodes.has(id)){const item=element();item.id=id;}return nodes.get(id);};
  const panel=element('section');panel.append(get('assistant-enabled'),get('assistant-summary'),get('assistant-status'));
  const hooks={open:[],sync:[],select:[],view:[]},ai={configured:true,provider:'openai',model:'test',baseUrl:'',hasKey:false,providers:{openai:{label:'OpenAI',model:'test',baseUrl:'',key:true}}};
  const api=async(route,method='GET',input)=>{
    requests.push({route,method,input});if(route==='/kb')return {documents:[]};if(route==='/products')return {products:[]};if(route==='/ai')return ai;
    if(route==='/assistant'){if(method==='PUT'){if(save)await save(input);settings={...settings,...input};}return structuredClone(settings);}throw Error('Unexpected '+route);
  };
  const C={$:get,el:element,api,notice(){},dateTime:String,initials:()=>'',phoneLabel:String,chats:()=>[],selected:()=>null,hooks,showView(){}};
  const document={createElement:element,createElementNS:element,createDocumentFragment:()=>element('fragment'),addEventListener(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/pages.js'),'utf8'),{WhatsAppCentral:C,document,Intl,Map,Set,URL,atob,Uint8Array,confirm:text=>{prompts.push(text);return true;}});
  await settle();for(const callback of hooks.view)callback('page-ai');await settle();
  return {get,requests,prompts};
}

test('assistant audience controls reflect saved settings without mutating them',async()=>{
  const b=await browser({audience:'new',enabled:true});assert.equal(b.get('assistant-audience').value,'new');assert.match(b.get('assistant-audience-hint').textContent,/nunca|histórico|nova/i);assert.equal(b.get('assistant-enabled').checked,true);assert.equal(b.requests.some(item=>item.method==='PUT'),false);
});
test('saving an audience is explicit and does not enable the assistant or rewrite contacts',async()=>{
  const b=await browser();b.get('assistant-audience').value='all';await b.get('assistant-audience').emit('change');assert.equal(b.requests.some(item=>item.method==='PUT'),false);await b.get('assistant-audience-save').emit('click');
  const saved=b.requests.find(item=>item.method==='PUT');assert.deepEqual(Object.keys(saved.input),['audience']);assert.equal(saved.input.audience,'all');assert.equal(b.get('assistant-enabled').checked,false);assert.match(b.get('assistant-audience-hint').textContent,/Desligada|pausa/i);
});
test('failed audience save keeps chosen audience visible and saved settings intact',async()=>{
  const b=await browser({save:async()=>{throw Error('Conexão indisponível');}});b.get('assistant-audience').value='new';await b.get('assistant-audience-save').emit('click');assert.equal(b.get('assistant-audience').value,'new');assert.match(b.get('assistant-audience-status').textContent,/Conexão indisponível/);assert.equal(b.get('assistant-enabled').checked,false);
});
test('enabling automatic replies names the saved audience in its existing confirmation',async()=>{
  const b=await browser({audience:'all'});b.get('assistant-enabled').checked=true;await b.get('assistant-enabled').emit('change');assert.match(b.prompts[0],/todos os contatos/i);assert.match(b.prompts[0],/Desligada|pausa/i);
});
