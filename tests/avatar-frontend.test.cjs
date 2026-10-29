const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const chat=n=>({jid:`55119987654${n}@s.whatsapp.net`,name:'Contato '+n});
function setup(api) {
  let intersect;const observed=new Set();
  class Observer {constructor(callback){intersect=callback;}observe(node){observed.add(node);}unobserve(node){observed.delete(node);}}
  function element(tag='span') {let text='';return {tagName:tag.toUpperCase(),children:[],dataset:{},isConnected:true,classList:{add(){},remove(){}},get textContent(){return text;},set textContent(value){text=value;this.children=[];},append(...nodes){this.children.push(...nodes);},setAttribute(){},addEventListener(type,fn){this['on'+type]=fn;}};}
  const window={IntersectionObserver:Observer};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/avatars.js'),'utf8'),{window,document:{createElement:element},IntersectionObserver:Observer,Map,Set,Date,queueMicrotask});
  const avatars=window.WhatsAppAvatars;avatars.init({api});return {avatars,element,trigger:node=>intersect([{target:node,isIntersecting:true}]),observed};
}
test('fotos só carregam ao aparecer e reutilizam cache para o mesmo contato',async()=>{
  let calls=0;const b=setup(async()=>{calls++;return {base64:'/9j/',mimeType:'image/jpeg'};}),a=b.element(),header=b.element();
  b.avatars.decorate(a,chat(1));await flush();assert.equal(calls,0);b.trigger(a);await flush();assert.equal(calls,1);assert.equal(a.children[0].tagName,'IMG');
  header.isConnected=false;b.avatars.decorate(header,chat(1),{eager:true});await flush();assert.equal(calls,1);assert.equal(header.children[0].src,a.children[0].src);
});
test('fila de fotos limita chamadas concorrentes a três',async()=>{
  let active=0,max=0;const release=[];const b=setup(async()=>{active++;max=Math.max(max,active);await new Promise(r=>release.push(r));active--;return {base64:null,mimeType:null};});
  for(let n=1;n<=6;n++) b.avatars.decorate(b.element(),chat(n),{eager:true});await flush();assert.equal(active,3);
  release.splice(0).forEach(r=>r());await flush();assert.equal(active,3);release.splice(0).forEach(r=>r());await flush();assert.equal(active,0);assert.equal(max,3);
});
test('foto atrasada não substitui o contato selecionado depois',async()=>{
  const release=new Map(),b=setup(async route=>{const jid=new URL('http://local'+route).searchParams.get('jid');await new Promise(r=>release.set(jid,r));return {base64:jid===chat(1).jid?'YQ==':'Yg==',mimeType:'image/png'};}),header=b.element();
  b.avatars.decorate(header,chat(1),{eager:true});b.avatars.decorate(header,chat(2),{eager:true});await flush();release.get(chat(1).jid)();await flush();assert.equal(header.children.length,0);
  release.get(chat(2).jid)();await flush();assert.match(header.children[0].src,/Yg==$/);
});
test('foto indisponível mantém iniciais e resultado negativo evita pedidos repetidos',async()=>{
  let calls=0;const b=setup(async()=>{calls++;return {base64:null,mimeType:null};}),avatar=b.element();b.avatars.decorate(avatar,chat(1),{eager:true});await flush();assert.equal(avatar.textContent,'C1');assert.equal(avatar.children.length,0);
  b.avatars.decorate(b.element(),chat(1),{eager:true});await flush();assert.equal(calls,1);
});
