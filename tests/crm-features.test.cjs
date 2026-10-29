const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const featureFile=path.join(__dirname,'../public/features.js');
const jid='5511998765432@s.whatsapp.net';
function browser({enabled=false}={}) {
  const nodes=new Map(),requests=[],opened=[],notices=[];
  function element(tag='div') {
    let text='',id='';const listeners=new Map();
    return {tagName:tag.toUpperCase(),children:[],value:'',checked:false,disabled:false,hidden:false,open:false,dataset:{},className:'',
      get id(){return id;},set id(value){id=value;nodes.set(value,this);},
      get textContent(){return text+this.children.map(child=>child.textContent).join('');},set textContent(value){text=String(value);this.children=[];},
      append(...items){this.children.push(...items);},replaceChildren(...items){text='';this.children=[];this.append(...items);},remove(){this.removed=true;},
      addEventListener(type,fn){if(!listeners.has(type)) listeners.set(type,[]);listeners.get(type).push(fn);},
      async emit(type,event={}){for(const fn of listeners.get(type)||[]) await fn({preventDefault(){},target:this,submitter:null,...event});},
      setAttribute(){},removeAttribute(){},focus(){},showModal(){this.open=true;},close(){this.open=false;},
      querySelector(selector){return walk(this).find(child=>selector.startsWith('.')?String(child.className).split(' ').includes(selector.slice(1)):child.id===selector.slice(1));},
      classList:{toggle(){},add(){},remove(){}}
    };
  }
  function walk(node){return node.children.flatMap(child=>[child,...walk(child)]);}
  const nav=element('nav'),contact=element(),body=element('body');contact.id='contact-details';body.append(nav,contact);
  const topTitle=element('strong'),topSubtitle=element('small'),caption=element('span');
  const document={body,createElement:element,getElementById:id=>nodes.get(id)||null,querySelector:selector=>({'.main-nav':nav,'#contact-details':contact,'.manual-card strong':topTitle,'.manual-card small':topSubtitle,'.local-caption':caption})[selector]||null};
  let rows=[{jid,name:'Ana <script>',labels:['Milhas'],notes:[{text:'Nota anterior'}],crm:{stage:'new',notes:'',followUpAt:null,history:[]},automationPaused:false}],settings={enabled,enabledSince:enabled?'2026-10-28T12:00:00Z':null,cooldownSeconds:60,rules:[]};
  const stages=[{id:'new',label:'Novo'},{id:'contacted',label:'Em contato'},{id:'negotiating',label:'Em negociação'},{id:'won',label:'Concluído'},{id:'lost',label:'Não avançou'}];
  const api=async(route,method='GET',input)=>{
    requests.push({route,method,input});
    if(route==='/crm') return {stages,contacts:rows};
    if(route.startsWith('/crm?')) {rows=rows.map(row=>row.jid===jid?{...row,crm:{...row.crm,...Object.fromEntries(Object.entries(input).filter(([key])=>key!=='automationPaused'))},...(input.automationPaused!==undefined?{automationPaused:input.automationPaused}:{})}:row);return rows[0];}
    if(route==='/automation/settings') {if(method==='PATCH') settings={...settings,...input};return settings;}
    if(route==='/automation/executions') return [];
    if(route==='/automation/simulate') return {matched:true,rule:{id:'r1',name:'Preço'},reply:'Resposta de teste'};
    throw new Error('Rota inesperada '+route);
  };
  const window={};if(fs.existsSync(featureFile)) vm.runInNewContext(fs.readFileSync(featureFile,'utf8'),{window,document,Date,Intl,Map,Set,URLSearchParams,crypto:{randomUUID:()=>String(Math.random())},setTimeout,clearTimeout,console});
  assert.equal(typeof window.WhatsAppFeatures?.init,'function');
  window.WhatsAppFeatures.init({api,notice:(...args)=>notices.push(args),openChat:chat=>opened.push(chat),getChats:()=>rows});
  return {feature:window.WhatsAppFeatures,get:id=>nodes.get(id),body,nav,requests,opened,notices,walk,rows,topTitle,caption};
}
test('features adiciona CRM e automações sem ativar robô nem enviar mensagens',()=>{
  const b=browser();assert.ok(b.get('nav-crm'));assert.ok(b.get('nav-automation'));assert.equal(b.requests.length,0);
});
test('CRM lista contatos reais com pesquisa e salva retorno, observações e etapa',async()=>{
  const b=browser();await b.get('nav-crm').emit('click');assert.equal(b.get('crm-dialog').open,true);assert.match(b.get('crm-board').textContent,/Ana <script>/);
  b.get('crm-search').value='inexistente';await b.get('crm-search').emit('input');assert.doesNotMatch(b.get('crm-board').textContent,/Ana/);
  b.get('crm-search').value='';await b.get('crm-search').emit('input');
  const edit=b.walk(b.get('crm-board')).find(node=>node.tagName==='BUTTON' && node.textContent==='Organizar');await edit.emit('click');
  b.get('crm-stage').value='negotiating';b.get('crm-notes').value='Retornar com valores';b.get('crm-followup').value='2026-11-01T12:30';
  await b.get('crm-edit-form').emit('submit');const saved=b.requests.findLast(item=>item.method==='PATCH');assert.equal(saved.input.stage,'negotiating');assert.equal(saved.input.notes,'Retornar com valores');assert.ok(saved.input.followUpAt.endsWith('Z'));
  const open=b.walk(b.get('crm-board')).find(node=>node.tagName==='BUTTON' && node.textContent==='Abrir conversa');await open.emit('click');assert.equal(b.opened[0].jid,jid);assert.equal(b.get('crm-dialog').open,false);
});
test('robô salva regras desligado, simula sem envio e só ativa em comando explícito',async()=>{
  const b=browser();await b.get('nav-automation').emit('click');assert.equal(b.get('automation-dialog').open,true);
  await b.get('automation-add-rule').emit('click');b.get('automation-rule-name-0').value='Preço';b.get('automation-rule-keywords-0').value='preço, valor';b.get('automation-rule-response-0').value='Consulte os valores';
  await b.get('automation-form').emit('submit');let saved=b.requests.findLast(item=>item.method==='PATCH');assert.equal(saved.input.enabled,undefined);assert.equal(saved.input.rules[0].response,'Consulte os valores');
  b.get('automation-test-text').value='Qual o preço?';await b.get('automation-test-form').emit('submit');assert.match(b.get('automation-test-result').textContent,/Resposta de teste/);assert.equal(b.requests.some(item=>item.route==='/send'),false);
  await b.get('automation-toggle').emit('click');saved=b.requests.findLast(item=>item.method==='PATCH');assert.equal(saved.input.enabled,true);
  await b.get('automation-toggle').emit('click');saved=b.requests.findLast(item=>item.method==='PATCH');assert.equal(saved.input.enabled,false);
});
test('contato selecionado mostra pausa individual e persiste passagem para atendimento manual',async()=>{
  const b=browser();b.feature.onChats(b.rows);await b.feature.onSelectChat(b.rows[0]);assert.ok(b.get('contact-automation-pause'));
  await b.get('contact-automation-pause').emit('click');assert.equal(b.requests.findLast(item=>item.method==='PATCH').input.automationPaused,true);assert.match(b.get('contact-automation-pause').textContent,/Retomar/);
});
test('mostra estado global salvo sem ativar e limita consultas de estado a quinze segundos',async()=>{
  const b=browser({enabled:true});b.feature.onChats(b.rows);await new Promise(resolve=>setImmediate(resolve));
  assert.match(b.topTitle.textContent,/Robô/);assert.match(b.caption.textContent,/ativado/);b.feature.onChats(b.rows);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.requests.filter(item=>item.route==='/automation/settings').length,1);assert.equal(b.requests.some(item=>item.method==='PATCH'),false);
});
