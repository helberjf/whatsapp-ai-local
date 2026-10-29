(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const TYPES={first_contact:'Primeiro contato',keyword:'Palavra-chave',absence:'Ausência'};
  const DAYS=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const MEDIA=new Set(['audio','image','video','document']);
  const EXECUTIONS={queued:'Na fila',waiting:'Aguardando',sending:'Enviando',sent:'Enviada',cancelled:'Cancelada',error:'Erro',failed:'Erro',uncertain:'Envio sem confirmação'};
  let hooks,initialized=false,settings=null,draft=null,busy=false,loading=false,chats=[],deleting=null;
  const previewUrls=new Set();
  function releasePreviews() {for(const url of previewUrls) URL.revokeObjectURL(url);previewUrls.clear();}
  function node(tag,className,text,id) {const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;if(id)item.id=id;return item;}
  function icon(name) {const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
  function button(text,action,className='button secondary',id) {const item=node('button',className,text,id);item.type='button';item.addEventListener('click',action);return item;}
  function input(id,type='text',value='') {const item=node('input','',undefined,id);item.type=type;item.value=value;return item;}
  function field(text,item,hint) {const label=node('label','trigger-field',text);label.append(item);if(hint)label.append(node('small','',hint));return label;}
  function option(select,value,text) {const item=node('option','',text);item.value=value;select.append(item);}
  function select(id,options,value) {const item=node('select','',undefined,id);for(const [key,label] of options)option(item,key,label);item.value=value;return item;}
  function toggle(id,label,value=false) {const item=node('label','trigger-toggle'),box=input(id,'checkbox');box.checked=value;const track=node('span','trigger-switch');track.setAttribute('aria-hidden','true');item.append(box,track,node('span','',label));return item;}
  function status(id,text,error=false) {$(id).textContent=text;$(id).className='trigger-status'+(error?' trigger-error':'');}
  function clone(value) {return JSON.parse(JSON.stringify(value));}
  function blank() {return {id:'',name:'',enabled:true,type:'first_contact',keywords:[],match:'contains',inactiveDays:null,delaySeconds:0,timezone:'America/Sao_Paulo',schedule:{days:[1,2,3,4,5],start:'09:00',end:'18:00'},messages:[{type:'text',text:''}]};}
  function timeLabel(value) {const parsed=Date.parse(value);return Number.isFinite(parsed)?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(parsed)):'';}
  function setBusy(value) {
    busy=value;for(const id of ['trigger-save','trigger-cancel','trigger-editor-close','trigger-new','triggers-enabled','triggers-cooldown-save'])$(id).disabled=value;
    $('trigger-save').textContent=value?'Salvando…':'Salvar gatilho';
  }
  function managerState() {
    if(!settings)return;
    $('triggers-enabled').checked=settings.enabled;
    $('triggers-cooldown').value=String(settings.cooldownSeconds);
    const enabled=settings.rules.filter(rule=>rule.enabled).length;
    $('triggers-summary').textContent=settings.enabled?`${enabled} gatilho(s) ativo(s). Respostas apenas a novas mensagens recebidas.`:'Gatilhos desligados. Salve suas regras e ligue a chave geral quando estiver pronto.';
    $('triggers-state').textContent=settings.enabled?'Ligados':'Desligados';$('triggers-state').dataset.enabled=String(settings.enabled);
    if(settings.lastError)status('triggers-status',settings.lastError,true);
    renderRules();
  }
  async function load() {
    if(loading)return;loading=true;$('trigger-new').disabled=true;$('triggers-enabled').disabled=true;status('triggers-status','Carregando gatilhos…');
    try {settings=await hooks.api('/triggers');status('triggers-status','');managerState();}
    catch(error) {status('triggers-status',error.message || 'Não foi possível carregar os gatilhos.',true);}
    finally {loading=false;$('trigger-new').disabled=!settings;$('triggers-enabled').disabled=!settings;}
  }
  async function open() {if(!$('triggers-dialog').open)$('triggers-dialog').showModal();await load();}
  async function update(patch,message) {
    if(busy || !settings)return false;setBusy(true);status('triggers-status','Salvando…');
    try {settings=await hooks.api('/triggers','PUT',patch);managerState();status('triggers-status',message);return true;}
    catch(error) {managerState();status('triggers-status',error.message || 'Não foi possível salvar.',true);return false;}
    finally {setBusy(false);}
  }
  function renderRules() {
    const list=$('triggers-list');list.replaceChildren();
    if(!settings.rules.length) {
      const empty=node('div','triggers-empty');empty.append(icon('bolt'),node('h3','','Sua primeira resposta começa aqui'),node('p','','Dê boas-vindas, responda por palavra-chave ou avise quando estiver fora do horário.'));list.append(empty);return;
    }
    settings.rules.forEach((rule,index)=>{
      const card=node('article','trigger-rule'+(rule.enabled?'':' is-off')),top=node('div','trigger-rule-top'),title=node('div','trigger-rule-title');
      title.append(node('strong','',rule.name),node('small','',TYPES[rule.type] || rule.type));const state=node('span','trigger-badge',rule.enabled?'Ativo':'Pausado');state.dataset.enabled=String(rule.enabled);top.append(title,state);
      const response=rule.messages.map(message=>message.type==='text'?message.text:message.type==='poll'?'Enquete: '+message.name:message.type==='audio'?'Áudio: '+message.fileName:'Anexo: '+message.fileName).join(' · ');
      card.append(top,node('p','trigger-rule-preview',response));
      const details=[];if(rule.type==='keyword')details.push(rule.keywords.join(', '));if(rule.type==='absence')details.push('Fora de '+rule.schedule.start+'–'+rule.schedule.end+' · '+rule.schedule.days.map(day=>DAYS[day]).join(', '));if(rule.inactiveDays)details.push('Inatividade de '+rule.inactiveDays+' dia(s)');if(rule.delaySeconds)details.push('Espera de '+rule.delaySeconds+' s');
      if(details.length)card.append(node('small','trigger-rule-details',details.join(' · ')));
      const actions=node('div','trigger-rule-actions');
      actions.append(button('Editar',()=>{if(!busy)edit(rule);},'text-button'),button(rule.enabled?'Pausar':'Ativar',()=>update({rules:settings.rules.map(item=>item.id===rule.id?{...item,enabled:!item.enabled}:item)},'Gatilho atualizado.'),'text-button'));
      if(index>0) {const up=button('↑',()=>{const rules=[...settings.rules];[rules[index-1],rules[index]]=[rules[index],rules[index-1]];return update({rules},'Ordem atualizada.');},'trigger-order');up.setAttribute('aria-label','Mover '+rule.name+' para cima');actions.append(up);}
      if(index<settings.rules.length-1) {const down=button('↓',()=>{const rules=[...settings.rules];[rules[index+1],rules[index]]=[rules[index],rules[index+1]];return update({rules},'Ordem atualizada.');},'trigger-order');down.setAttribute('aria-label','Mover '+rule.name+' para baixo');actions.append(down);}
      actions.append(button(deleting===rule.id?'Confirmar exclusão':'Excluir',async()=>{if(busy)return;if(deleting!==rule.id){deleting=rule.id;renderRules();return;}await update({rules:settings.rules.filter(item=>item.id!==rule.id)},'Gatilho excluído.');deleting=null;},'text-button trigger-delete'));
      card.append(actions);list.append(card);
    });
  }
  function conditionState() {
    const type=$('trigger-type').value;$('trigger-keywords-fields').hidden=type!=='keyword';$('trigger-hours-section').hidden=type!=='absence';
    for(const value of Object.keys(TYPES)) {const choice=$('trigger-type-'+value);choice?.classList.toggle('active',value===type);choice?.setAttribute('aria-pressed',String(value===type));}
    const descriptions={first_contact:'Responde à primeira mensagem de uma conversa nova. Conversas antigas não recebem boas-vindas novamente.',keyword:'Responde quando a mensagem recebida contém uma das palavras ou frases abaixo.',absence:'Responde a mensagens recebidas fora dos dias e horários de atendimento definidos abaixo.'};
    $('trigger-condition-hint').textContent=descriptions[type];
    $('trigger-inactive-days').disabled=!$('trigger-inactivity-enabled').checked;
  }
  function edit(rule=null) {
    if(!settings || busy)return;draft=rule?clone(rule):blank();
    $('trigger-editor-title').textContent=rule?'Editar gatilho':'Novo gatilho';$('trigger-name').value=draft.name;$('trigger-enabled').checked=draft.enabled;
    $('trigger-type').value=draft.type;$('trigger-keywords').value=draft.keywords.join(', ');$('trigger-match').value=draft.match;
    $('trigger-inactivity-enabled').checked=draft.inactiveDays!==null;$('trigger-inactive-days').value=String(draft.inactiveDays || 7);$('trigger-delay').value=String(draft.delaySeconds);
    $('trigger-timezone').value=draft.timezone;$('trigger-hours-start').value=draft.schedule.start;$('trigger-hours-end').value=draft.schedule.end;
    DAYS.forEach((name,index)=>{$('trigger-day-'+index).checked=draft.schedule.days.includes(index);});
    status('trigger-form-status','');conditionState();renderMessages();$('trigger-editor-dialog').showModal();$('trigger-name').focus();
  }
  function messageType(index,type) {
    if(busy)return;const current=draft.messages[index];
    if(current.type===type)return;
    draft.messages[index]=type==='text'?{type,text:current.caption || ''}:type==='poll'?{type,name:'',options:[],selectableCount:1}:{type,base64:'',mimeType:'',fileName:'',caption:''};renderMessages();
  }
  function fileBase64(file) {return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(file);});}
  async function readMedia(index,file,audioOnly) {
    if(!file || busy)return;
    const target=draft.messages[index];
    try {
      if(file.size>10*1024*1024)throw Error('Use arquivos de até 10 MB.');
      if(audioOnly && !String(file.type).startsWith('audio/'))throw Error('Selecione um arquivo de áudio.');
      const base64=await fileBase64(file);if(draft.messages[index]!==target)return;
      const type=audioOnly?'audio':String(file.type).startsWith('image/')?'image':String(file.type).startsWith('video/')?'video':String(file.type).startsWith('audio/')?'audio':'document';
      Object.assign(target,{type,base64,mimeType:file.type || 'application/octet-stream',fileName:file.name});status('trigger-form-status','');renderMessages();
    } catch(error) {status('trigger-form-status',error.message,true);}
  }
  function renderMessages() {
    const list=$('trigger-messages');releasePreviews();list.replaceChildren();
    draft.messages.forEach((message,index)=>{
      const card=node('article','trigger-message-card'),head=node('div','trigger-message-head');head.append(node('span','trigger-message-number',String(index+1)),node('strong','','Mensagem '+(index+1)));
      if(draft.messages.length>1) {const remove=button('×',()=>{if(!busy){draft.messages.splice(index,1);renderMessages();}},'trigger-remove');remove.setAttribute('aria-label','Remover mensagem '+(index+1));head.append(remove);}card.append(head);
      const tabs=node('div','trigger-message-tabs');
      for(const [type,text] of [['text','Texto'],['audio','Áudio'],['poll','Enquete']]) {const active=message.type===type,tab=button(text,()=>messageType(index,type),'trigger-message-tab'+(active?' active':''),'trigger-message-'+type+'-'+index);tab.setAttribute('aria-pressed',String(active));tabs.append(tab);}
      card.append(tabs);
      if(message.type==='text') {
        const text=node('textarea','trigger-message-text',undefined,'trigger-message-text-'+index);text.rows=6;text.maxLength=10000;text.placeholder='Escreva sua mensagem…';text.value=message.text;text.setAttribute('aria-label','Texto da mensagem '+(index+1));text.addEventListener('input',()=>{message.text=text.value;});card.append(text);
      } else if(message.type==='poll') {
        const name=input('trigger-poll-name-'+index,'text',message.name);name.maxLength=255;name.placeholder='O que você gostaria de saber?';name.addEventListener('input',()=>{message.name=name.value;});
        const options=node('textarea','',undefined,'trigger-poll-options-'+index);options.rows=4;options.placeholder='Primeira opção\nSegunda opção';options.value=message.options.join('\n');options.addEventListener('input',()=>{message.options=options.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);});
        card.append(field('Pergunta da enquete',name),field('Opções · uma por linha',options,'De 2 a 10 opções. Cada pessoa poderá escolher uma.'));
      } else {
        const file=input('trigger-media-file-'+index,'file');if(message.type==='audio')file.accept='audio/*';file.addEventListener('change',async()=>{const chosen=file.files?.[0];file.value='';await readMedia(index,chosen,message.type==='audio');});
        card.append(field(message.type==='audio'?'Arquivo de áudio':'Arquivo anexado',file,'O arquivo fica salvo neste computador. Até 10 MB no total de todos os gatilhos.'));
        if(message.fileName)card.append(node('p','trigger-file-name',message.fileName));
        if(message.base64 && message.type==='audio') {const preview=node('audio','trigger-media-preview');preview.controls=true;preview.preload='none';const bytes=Uint8Array.from(atob(message.base64),char=>char.charCodeAt(0));preview.src=URL.createObjectURL(new Blob([bytes],{type:message.mimeType}));previewUrls.add(preview.src);preview.setAttribute('aria-label','Ouvir áudio da mensagem '+(index+1));card.append(preview);}
        if(message.type!=='audio') {const caption=input('trigger-caption-'+index,'text',message.caption || '');caption.maxLength=1000;caption.addEventListener('input',()=>{message.caption=caption.value;});card.append(field('Legenda (opcional)',caption));}
      }
      const foot=node('div','trigger-message-foot'),attach=button('Anexar arquivo',()=>messageType(index,'document'),'text-button');attach.prepend?.(icon('attach'));foot.append(attach,node('span','','Imagem, vídeo ou documento'));card.append(foot);list.append(card);
    });
    $('trigger-add-message').disabled=draft.messages.length>=10;$('trigger-message-count').textContent=draft.messages.length+'/10 mensagens';
  }
  function collect() {
    const rule={...clone(draft),name:$('trigger-name').value.trim(),enabled:$('trigger-enabled').checked,type:$('trigger-type').value,keywords:$('trigger-keywords').value.split(/[,\n]/).map(value=>value.trim()).filter(Boolean),match:$('trigger-match').value,inactiveDays:$('trigger-inactivity-enabled').checked?Number($('trigger-inactive-days').value):null,delaySeconds:Number($('trigger-delay').value),timezone:$('trigger-timezone').value.trim(),schedule:{days:DAYS.map((name,index)=>index).filter(index=>$('trigger-day-'+index).checked),start:$('trigger-hours-start').value,end:$('trigger-hours-end').value}};
    if(!rule.name || rule.name.length>80)throw Error('Dê um nome ao gatilho, com até 80 caracteres.');
    if(rule.type==='keyword' && !rule.keywords.length)throw Error('Adicione pelo menos uma palavra-chave.');
    if(rule.keywords.length>50)throw Error('Use até 50 palavras-chave.');
    if(!Number.isInteger(rule.delaySeconds) || rule.delaySeconds<0 || rule.delaySeconds>86400)throw Error('A espera deve ser de 0 a 86.400 segundos.');
    if(rule.inactiveDays!==null && (!Number.isInteger(rule.inactiveDays) || rule.inactiveDays<1 || rule.inactiveDays>3650))throw Error('A inatividade deve ser de 1 a 3.650 dias.');
    if(!rule.schedule.days.length || !/^\d{2}:\d{2}$/.test(rule.schedule.start) || !/^\d{2}:\d{2}$/.test(rule.schedule.end))throw Error('Escolha ao menos um dia e preencha os horários de atendimento.');
    try {new Intl.DateTimeFormat('pt-BR',{timeZone:rule.timezone}).format(new Date());} catch {throw Error('Escolha um fuso horário válido, como America/Sao_Paulo.');}
    for(const [index,message] of rule.messages.entries()) {
      if(message.type==='text' && (!message.text.trim() || message.text.length>10000))throw Error('Escreva a mensagem '+(index+1)+' (até 10.000 caracteres).');
      if(message.type==='poll' && (!message.name.trim() || message.options.length<2 || message.options.length>10 || new Set(message.options.map(value=>value.toLocaleLowerCase('pt-BR'))).size!==message.options.length))throw Error('Preencha a pergunta e de 2 a 10 opções diferentes na enquete '+(index+1)+'.');
      if(MEDIA.has(message.type) && !message.base64)throw Error('Adicione o arquivo da mensagem '+(index+1)+'.');
    }
    if(!rule.id) delete rule.id;
    return rule;
  }
  async function save(event) {
    event.preventDefault();if(busy || !settings)return;let rule;
    try {rule=collect();}catch(error){status('trigger-form-status',error.message,true);return;}
    const rules=rule.id?settings.rules.map(item=>item.id===rule.id?rule:item):[...settings.rules,rule];
    setBusy(true);status('trigger-form-status','Salvando gatilho…');
    try {settings=await hooks.api('/triggers','PUT',{rules});managerState();status('trigger-form-status','');$('trigger-editor-dialog').close();status('triggers-status',settings.enabled?'Gatilho salvo. Vale para as próximas mensagens.':'Gatilho salvo. A chave geral continua desligada.');hooks.notice('Gatilho salvo.',true);}
    catch(error){status('trigger-form-status',error.message || 'Não foi possível salvar o gatilho.',true);}
    finally{setBusy(false);}
  }
  async function simulate(event) {
    event.preventDefault();const submit=$('trigger-test-submit');if(submit.disabled)return;
    const previous=$('trigger-test-previous').value,at=$('trigger-test-at').value;
    if((previous && !Number.isFinite(new Date(previous).getTime())) || (at && !Number.isFinite(new Date(at).getTime()))) {status('trigger-test-result','Preencha datas e horários válidos.',true);return;}
    submit.disabled=true;status('trigger-test-result','Testando regras salvas…');
    try {const result=await hooks.api('/triggers/simulate','POST',{text:$('trigger-test-text').value,firstContact:$('trigger-test-first').checked,previousMessageAt:previous?new Date(previous).toISOString():null,...(at?{at:new Date(at).toISOString()}:{})});status('trigger-test-result',result.matched?'Gatilho encontrado: '+result.rule.name+' · '+result.messages.length+' mensagem(ns) de resposta. Nenhuma mensagem foi enviada.':'Nenhum gatilho ativo corresponde a esta mensagem.');}
    catch(error){status('trigger-test-result',error.message,true);}finally{submit.disabled=false;}
  }
  async function executions() {
    const refresh=$('trigger-executions-refresh');if(refresh.disabled)return;refresh.disabled=true;const list=$('trigger-executions');list.replaceChildren(node('p','muted','Carregando atividade…'));
    try {const records=await hooks.api('/triggers/executions');list.replaceChildren();if(!records.length)list.append(node('p','muted','Ainda sem disparos.'));
      for(const entry of records.slice(0,30)) {const row=node('div','trigger-execution'),chat=chats.find(item=>item.jid===entry.jid),label=chat?.name || (String(entry.jid).endsWith('@lid')?'Contato · ID '+entry.jid.split('@')[0]:entry.jid.split('@')[0]);row.append(node('strong','',entry.ruleName+' · '+(EXECUTIONS[entry.status] || entry.status)),node('small','',label+' · '+timeLabel(entry.createdAt)+(entry.sentCount?' · '+entry.sentCount+' enviada(s)':'')));list.append(row);}
    }catch(error){list.replaceChildren(node('p','trigger-status trigger-error',error.message));}finally{refresh.disabled=false;}
  }
  function buildManager() {
    const dialog=node('dialog','triggers-dialog',undefined,'triggers-dialog');dialog.setAttribute('aria-labelledby','triggers-title');const head=node('div','triggers-manager-head'),heading=node('div');heading.append(node('p','trigger-eyebrow','AUTOMAÇÕES'),node('h2','','Gatilhos','triggers-title'));
    const close=button('×',()=>{if(!busy)dialog.close();},'trigger-close');close.setAttribute('aria-label','Fechar gatilhos');head.append(heading,close);
    const body=node('div','triggers-manager-body'),intro=node('div','triggers-intro'),copy=node('div');copy.append(node('h3','','A resposta certa, na hora certa'),node('p','','Mensagens automáticas para receber novos contatos, reconhecer palavras-chave e avisar sobre seu horário de atendimento.'));intro.append(node('span','trigger-feature-icon','ϟ'),copy);
    const master=node('div','triggers-master'),masterTitle=node('div');masterTitle.append(toggle('triggers-enabled','Permitir respostas dos gatilhos'),node('p','',undefined,'triggers-summary'));master.append(masterTitle,node('span','trigger-badge','Desligados','triggers-state'));
    const toolbar=node('div','triggers-toolbar');toolbar.append(node('h3','','Seus gatilhos'),button('+ Novo gatilho',()=>edit(),'button primary','trigger-new'));
    const list=node('div','triggers-list',undefined,'triggers-list');const priority=node('p','trigger-note','Os gatilhos são avaliados na ordem da lista. A primeira regra correspondente responde. Gatilhos e respostas de IA não respondem juntos à mesma mensagem.');
    const cooldown=node('div','trigger-cooldown'),cooldownValue=input('triggers-cooldown','number','60');cooldownValue.min='10';cooldownValue.max='86400';cooldown.append(field('Intervalo mínimo por contato (segundos)',cooldownValue,'Evita repetir uma resposta em sequência.'),button('Salvar intervalo',async()=>{const value=Number(cooldownValue.value);if(!Number.isInteger(value)||value<10||value>86400){status('triggers-status','Use um intervalo entre 10 e 86.400 segundos.',true);return;}await update({cooldownSeconds:value},'Intervalo salvo.');},'button secondary','triggers-cooldown-save'));
    const test=node('details','trigger-details'),testForm=node('form','trigger-test-form',undefined,'trigger-test-form');test.append(node('summary','','Testar um gatilho sem enviar mensagens'));
    const text=node('textarea','',undefined,'trigger-test-text');text.rows=2;text.placeholder='Ex.: Olá, gostaria de conhecer o catálogo';testForm.append(field('Mensagem recebida de exemplo',text),toggle('trigger-test-first','Primeiro contato'),field('Última mensagem anterior (opcional)',input('trigger-test-previous','datetime-local')),field('Data e hora do teste (opcional)',input('trigger-test-at','datetime-local')),node('p','trigger-note','O teste usa as regras salvas e ativas, mesmo com a chave geral desligada. Horários de teste seguem o fuso deste computador.'),button('Testar gatilhos',()=>{},'button secondary','trigger-test-submit'),node('p','trigger-status','', 'trigger-test-result'));testForm.children[testForm.children.length-2].type='submit';testForm.addEventListener('submit',simulate);test.append(testForm);
    const activity=node('details','trigger-details');activity.append(node('summary','','Atividade recente'),button('Atualizar atividade',executions,'text-button','trigger-executions-refresh'),node('div','trigger-executions',undefined,'trigger-executions'));
    body.append(intro,master,node('p','trigger-status','','triggers-status'),toolbar,list,priority,cooldown,test,activity);
    dialog.append(head,body);dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.addEventListener('close',releasePreviews);document.body.append(dialog);
    $('triggers-enabled').addEventListener('change',async()=>{const enabled=$('triggers-enabled').checked;if(busy)return;await update({enabled},enabled?'Gatilhos ligados para as próximas mensagens.':'Gatilhos desligados.');});
  }
  function buildEditor() {
    const dialog=node('dialog','trigger-editor-dialog',undefined,'trigger-editor-dialog');dialog.setAttribute('aria-labelledby','trigger-editor-title');const form=node('form','trigger-form',undefined,'trigger-form'),head=node('div','trigger-editor-head'),title=node('div','trigger-editor-heading');title.append(node('span','trigger-title-icon','ϟ'),node('h2','','Novo gatilho','trigger-editor-title'));
    const close=button('×',()=>{if(!busy)dialog.close();},'trigger-close','trigger-editor-close');close.setAttribute('aria-label','Fechar edição do gatilho');head.append(title,toggle('trigger-enabled','Gatilho ativo',true),close);
    const layout=node('div','trigger-editor-layout'),conditions=node('section','trigger-conditions'),responses=node('section','trigger-responses');
    const name=input('trigger-name');name.maxLength=80;name.placeholder='Ex.: Mensagem de boas-vindas';conditions.append(field('Nome do gatilho',name));
    const type=select('trigger-type',Object.entries(TYPES),'first_contact');type.addEventListener('change',conditionState);const choices=node('div','trigger-type-choices');
    for(const [value,title] of Object.entries(TYPES)) {const choice=button('',()=>{type.value=value;conditionState();},'trigger-type-choice','trigger-type-'+value);choice.append(node('span','trigger-type-icon',{first_contact:'♙',keyword:'⚿',absence:'☾'}[value]),node('strong','',title),node('small','',{first_contact:'Alguém chama pela primeira vez',keyword:'A mensagem tem uma palavra',absence:'Mensagem fora do horário'}[value]));choices.append(choice);}
    const typeField=field('Quando acontecer',type);typeField.className+=' trigger-native-type';conditions.append(typeField,choices,node('p','trigger-condition-hint','','trigger-condition-hint'));
    const keywords=node('div','trigger-keywords-fields',undefined,'trigger-keywords-fields'),words=node('textarea','',undefined,'trigger-keywords');words.rows=2;words.placeholder='preço, catálogo, orçamento';keywords.append(field('Palavras-chave',words,'Separe palavras ou frases por vírgula.'),field('Correspondência',select('trigger-match',[['contains','Contém a palavra ou frase'],['word','Palavra inteira']],'contains')));conditions.append(keywords);
    const inactivity=node('div','trigger-inactivity');inactivity.append(toggle('trigger-inactivity-enabled','Apenas conversas inativas'),field('Dias sem conversar',input('trigger-inactive-days','number','7'),'Aplica também a contatos sem histórico.'));conditions.append(inactivity);
    const delay=input('trigger-delay','number','0');delay.min='0';delay.max='86400';conditions.append(field('Tempo de espera para responder',delay,'Em segundos. Use 0 para responder sem espera.'));
    const hours=node('section','trigger-hours-section',undefined,'trigger-hours-section');hours.append(node('h3','','Horário de atendimento'),node('p','trigger-note','A mensagem de ausência é enviada fora deste horário, inclusive nos dias desmarcados.'));
    const days=node('div','trigger-days');DAYS.forEach((name,index)=>{const day=node('label','trigger-day'),box=input('trigger-day-'+index,'checkbox');box.checked=[1,2,3,4,5].includes(index);day.append(box,node('span','',name));days.append(day);});hours.append(days);
    const times=node('div','trigger-times');times.append(field('Das',input('trigger-hours-start','time','09:00')),field('Até',input('trigger-hours-end','time','18:00')));hours.append(times,field('Fuso horário',input('trigger-timezone','text','America/Sao_Paulo'),'Ex.: America/Sao_Paulo. Horários que passam da meia-noite são aceitos.'));conditions.append(hours);
    const responseTitle=node('div','trigger-response-title');responseTitle.append(node('h3','','O que você deseja enviar?'),node('small','','1/10 mensagens','trigger-message-count'));responses.append(responseTitle,node('p','trigger-note','Adicione as respostas na ordem em que devem ser enviadas.'),node('div','trigger-messages',undefined,'trigger-messages'),button('+ Adicionar outra mensagem',()=>{if(!busy&&draft.messages.length<10){draft.messages.push({type:'text',text:''});renderMessages();}},'trigger-add-message','trigger-add-message'));
    layout.append(conditions,responses);const foot=node('footer','trigger-editor-footer'),actions=node('div','trigger-editor-actions'),save=button('Salvar gatilho',()=>{},'button primary','trigger-save');save.type='submit';actions.append(button('Cancelar',()=>{if(!busy)dialog.close();},'button secondary','trigger-cancel'),save);foot.append(node('p','trigger-status','','trigger-form-status'),actions);form.append(head,layout,foot);form.addEventListener('submit',saveHandler);dialog.append(form);dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.addEventListener('close',releasePreviews);document.body.append(dialog);
    $('trigger-inactivity-enabled').addEventListener('change',conditionState);
  }
  function saveHandler(event) {return save(event);}
  globalThis.WhatsAppTriggers={
    init(options) {if(initialized)return;initialized=true;hooks=options;chats=hooks.getChats?.() || [];buildManager();buildEditor();const nav=document.querySelector('.main-nav');if(nav){const entry=button('',open,'nav-item','nav-triggers');entry.setAttribute('aria-label','Gatilhos');entry.title='Gatilhos';entry.append(icon('bolt'),node('span','','Gatilhos'));const anchor=$('nav-automation') || $('settings');nav.insertBefore(entry,anchor?.nextSibling || null);}},
    onChats(value) {chats=Array.isArray(value)?value:[];},
    onSelectChat() {}
  };
})();
