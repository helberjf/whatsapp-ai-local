(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let hooks,initialized=false,contacts=[],stages=[],selected=null,editing=null,robotSettings=null,ruleRows=[],crmVersion=0,selectionVersion=0,lastRobotStatus=0,robotStatusRequest=null;
  const fallbackStages=[{id:'new',label:'Novo'},{id:'contacted',label:'Em contato'},{id:'negotiating',label:'Em negociação'},{id:'won',label:'Concluído'},{id:'lost',label:'Não avançou'}];
  const normalize=value=>String(value || '').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
  const formatDate=value=>value && Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'Sem retorno marcado';
  function node(tag,className,text,id) {const value=document.createElement(tag);if(className) value.className=className;if(text!==undefined) value.textContent=text;if(id) value.id=id;return value;}
  function button(text,action,className='button secondary',id) {const value=node('button',className,text,id);value.type='button';if(action) value.addEventListener('click',action);return value;}
  function field(label,input) {const value=node('label','field',label);value.append(input);return value;}
  function input(id,type='text',maxLength) {const value=node('input','',undefined,id);value.type=type;if(maxLength) value.maxLength=maxLength;return value;}
  function options(id,items) {const value=node('select','',undefined,id);for(const item of items) {const option=node('option','',item.label);option.value=item.id;value.append(option);}return value;}
  function status(id,text,error=false) {const target=$(id);if(target) {target.textContent=text;target.className='feature-status'+(error?' feature-error':'');}}
  async function busy(target,action,errorId) {if(target) target.disabled=true;try {await action();}catch(error) {if(errorId) status(errorId,error.message,true);else hooks.notice(error.message);}finally {if(target) target.disabled=false;}}
  function dialog(id,title,description) {
    const value=node('dialog','feature-dialog',undefined,id);value.setAttribute('aria-label',title);
    const head=node('div','feature-heading'),copy=node('div');copy.append(node('p','eyebrow','SUA CENTRAL PESSOAL'),node('h2','',title),node('p','feature-description',description));
    head.append(copy,button('×',()=>value.close(),'icon-button feature-close'));head.children[1].setAttribute('aria-label','Fechar '+title);value.append(head);document.body.append(value);return value;
  }
  function openDialog(id) {for(const other of ['crm-dialog','automation-dialog']) if(other!==id && $(other)?.open) $(other).close();if(!$(id).open) $(id).showModal();}
  function details(contact) {return {stage:'new',followUpAt:null,notes:'',history:[],...contact.crm};}
  function mergeContact(detail) {
    const index=contacts.findIndex(contact=>contact.jid===detail.jid);
    if(index>=0) contacts[index]={...contacts[index],...detail};
    const chat=hooks.getChats().find(chat=>chat.jid===detail.jid);if(chat) Object.assign(chat,detail);
    if(selected?.jid===detail.jid) {selected={...selected,...detail};renderContactTools();}
  }
  async function loadCrm() {
    const version=++crmVersion,result=await hooks.api('/crm');if(version!==crmVersion) return;
    stages=result.stages || fallbackStages;contacts=result.contacts || [];renderBoard();
    if(selected) {const current=contacts.find(contact=>contact.jid===selected.jid);if(current) {selected={...selected,...current};renderContactTools();}}
  }
  function renderBoard() {
    const board=$('crm-board');if(!board) return;
    const search=normalize($('crm-search').value),stage=$('crm-filter-stage').value,followup=$('crm-filter-followup').value;
    const filtered=contacts.filter(contact=>{
      const crm=details(contact),date=crm.followUpAt?Date.parse(crm.followUpAt):null;
      return (!search || normalize([contact.name,contact.jid,contact.labels?.join(' '),crm.notes].join(' ')).includes(search)) && (!stage || crm.stage===stage) && (!followup || (followup==='due'?date!==null && date<=Date.now():date!==null));
    });
    $('crm-summary').textContent=contacts.length+' contatos · '+contacts.filter(contact=>details(contact).followUpAt && Date.parse(details(contact).followUpAt)<=Date.now()).length+' retornos pendentes';
    board.replaceChildren();
    for(const stage of stages.length?stages:fallbackStages) {
      if($('crm-filter-stage').value && $('crm-filter-stage').value!==stage.id) continue;
      const column=node('section','crm-column');column.dataset.stage=stage.id;
      const rows=filtered.filter(contact=>details(contact).stage===stage.id),heading=node('div','crm-column-heading');heading.append(node('h3','',stage.label),node('span','count',String(rows.length)));column.append(heading);
      for(const contact of rows) {
        const crm=details(contact),card=node('article','crm-contact'),identity=node('div','crm-contact-identity');
        identity.append(node('strong','',contact.name || contact.jid.split('@')[0]),node('small','',contact.jid.split('@')[0]));card.append(identity);
        if(contact.labels?.length) card.append(node('p','crm-labels',contact.labels.join(' · ')));
        if(crm.followUpAt) {const due=node('p','crm-followup',formatDate(crm.followUpAt));due.classList.toggle('overdue',Date.parse(crm.followUpAt)<=Date.now());card.append(due);}
        if(crm.notes) card.append(node('p','crm-preview',crm.notes));
        if(contact.automationPaused) card.append(node('span','feature-tag','Robô pausado'));
        const actions=node('div','crm-card-actions');actions.append(button('Organizar',()=>openEditor(contact),'text-button'),button('Abrir conversa',()=>{$('crm-dialog').close();hooks.openChat(contact);},'text-button'));card.append(actions);column.append(card);
      }
      if(!rows.length) column.append(node('p','feature-empty','Nenhum contato nesta etapa.'));board.append(column);
    }
    if(!contacts.length) $('crm-summary').textContent='Nenhum contato sincronizado. Conecte o WhatsApp para carregar suas conversas.';
  }
  function localDate(value) {if(!value) return '';const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  function openEditor(contact) {
    editing=contact.jid;const crm=details(contact);$('crm-editor').hidden=false;$('crm-editor-name').textContent=contact.name || contact.jid.split('@')[0];
    $('crm-stage').value=crm.stage;$('crm-followup').value=localDate(crm.followUpAt);$('crm-notes').value=crm.notes;$('crm-pause').checked=contact.automationPaused===true;status('crm-edit-status','');
    $('crm-existing-notes').replaceChildren();
    for(const note of contact.notes || []) {const row=node('p','crm-existing-note',note.text);$('crm-existing-notes').append(row);}
    $('crm-existing-notes-section').hidden=!(contact.notes?.length);
    $('crm-history').replaceChildren();
    for(const event of [...crm.history].reverse().slice(0,15)) {
      const stageLabel=id=>(stages.length?stages:fallbackStages).find(stage=>stage.id===id)?.label || id;
      const description=event.type==='stage'?'Etapa: '+stageLabel(event.from)+' → '+stageLabel(event.to):'Próximo contato: '+formatDate(event.to);
      const row=node('li');row.append(node('span','',description),node('time','',formatDate(event.at)));$('crm-history').append(row);
    }
    if(!crm.history.length) $('crm-history').append(node('li','feature-empty','As mudanças de etapa e retorno ficam registradas aqui.'));
    $('crm-stage').focus();
  }
  async function openCrm(contact) {
    openDialog('crm-dialog');status('crm-status','Carregando contatos…');
    await busy(null,async()=>{await loadCrm();status('crm-status','');if(contact) openEditor(contacts.find(item=>item.jid===contact.jid) || contact);},'crm-status');
  }
  function buildCrm() {
    const value=dialog('crm-dialog','CRM de contatos','Acompanhe cada conversa, registre o próximo passo e marque quando retornar.');
    const toolbar=node('div','feature-toolbar'),search=input('crm-search','search',160);search.placeholder='Buscar nome, telefone ou observação';search.setAttribute('aria-label','Buscar contatos do CRM');
    const stage=options('crm-filter-stage',[{id:'',label:'Todas as etapas'},...fallbackStages]),followup=options('crm-filter-followup',[{id:'',label:'Todos os retornos'},{id:'scheduled',label:'Com retorno marcado'},{id:'due',label:'Retornos pendentes'}]);stage.setAttribute('aria-label','Filtrar etapa');followup.setAttribute('aria-label','Filtrar próximo contato');
    search.addEventListener('input',renderBoard);stage.addEventListener('change',renderBoard);followup.addEventListener('change',renderBoard);toolbar.append(search,stage,followup,button('Atualizar',()=>busy(null,loadCrm,'crm-status'),'button secondary'));value.append(toolbar,node('p','feature-summary','', 'crm-summary'),node('p','feature-status','','crm-status'));
    const layout=node('div','crm-layout'),board=node('div','crm-board',undefined,'crm-board'),editor=node('aside','crm-editor',undefined,'crm-editor');editor.hidden=true;
    const heading=node('div','feature-subheading');heading.append(node('h3','','','crm-editor-name'),button('×',()=>{editor.hidden=true;editing=null;},'icon-button'));heading.children[1].setAttribute('aria-label','Fechar edição do contato');editor.append(heading);
    const form=node('form','',undefined,'crm-edit-form'),stageInput=options('crm-stage',fallbackStages),followupInput=input('crm-followup','datetime-local'),notes=node('textarea','',undefined,'crm-notes');notes.rows=4;notes.maxLength=10000;notes.placeholder='Interesses, valores combinados e próximo passo…';
    const pause=input('crm-pause','checkbox'),pauseLabel=node('label','feature-checkbox');pauseLabel.append(pause,node('span','','Pausar robô e assumir atendimento manual'));
    const save=button('Salvar contato',null,'button primary','crm-save');save.type='submit';form.append(field('Etapa do contato',stageInput),field('Próximo contato',followupInput),field('Observações do CRM',notes),pauseLabel,save,node('p','feature-status','','crm-edit-status'));
    form.addEventListener('submit',async event=>{event.preventDefault();const jid=editing;if(!jid) return;await busy(save,async()=>{
      const detail=await hooks.api('/crm?jid='+encodeURIComponent(jid),'PATCH',{stage:stageInput.value,followUpAt:followupInput.value?new Date(followupInput.value).toISOString():null,notes:notes.value,automationPaused:pause.checked});mergeContact(detail);renderBoard();status('crm-edit-status','Contato salvo.');
    },'crm-edit-status');});editor.append(form);
    const existing=node('section','crm-existing-notes',undefined,'crm-existing-notes-section');existing.append(node('h3','','Notas do atendimento'),node('div','',undefined,'crm-existing-notes'));editor.append(existing,node('h3','crm-history-title','Histórico do CRM'),node('ol','crm-history',undefined,'crm-history'));layout.append(board,editor);value.append(layout);
  }
  function renderRobotState() {
    if(!robotSettings) return;
    const title=document.querySelector('.manual-card strong'),subtitle=document.querySelector('.manual-card small'),caption=document.querySelector('.local-caption');
    if(title) title.textContent=robotSettings.enabled?'Robô por palavras-chave':'Atendimento manual';
    if(subtitle) subtitle.textContent=robotSettings.enabled?'Respostas automáticas ativadas':'Robô desligado · você no controle';
    if(caption) caption.replaceChildren(node('i','small-dot'),node('span','',robotSettings.enabled?'Robô ativado':'Atendimento manual'));
    $('automation-state').textContent=robotSettings.enabled?'Robô ativado':'Robô desligado';$('automation-state').classList.toggle('enabled',robotSettings.enabled);
    $('automation-toggle').textContent=robotSettings.enabled?'Desligar robô':'Ativar robô';$('automation-toggle').className='button '+(robotSettings.enabled?'danger':'primary');
    $('automation-enabled-since').textContent=robotSettings.enabled?'Responde apenas a novas mensagens recebidas após '+formatDate(robotSettings.enabledSince)+'.':'Suas regras podem ser salvas e testadas com o robô desligado.';
    if(robotSettings.lastError) status('automation-status',robotSettings.lastError,true);
  }
  function refreshRobotStatus() {
    if(robotStatusRequest || Date.now()-lastRobotStatus<15000) return;
    lastRobotStatus=Date.now();
    robotStatusRequest=hooks.api('/automation/settings').then(value=>{robotSettings=value;renderRobotState();}).catch(()=>{}).finally(()=>{robotStatusRequest=null;});
  }
  function addRule(rule={}) {
    if(ruleRows.filter(row=>!row.removed).length>=100) return;
    const index=ruleRows.length,section=node('article','automation-rule'),heading=node('div','feature-subheading');
    const active=input('automation-rule-active-'+index,'checkbox');active.checked=rule.enabled!==false;const enabledLabel=node('label','feature-checkbox');enabledLabel.append(active,node('span','','Regra ativa'));
    heading.append(enabledLabel,button('Remover',()=>{record.removed=true;section.remove();},'text-button'));
    const name=input('automation-rule-name-'+index,'text',80);name.value=rule.name || '';name.required=true;name.placeholder='Nome da regra';
    const keywords=input('automation-rule-keywords-'+index,'text',8100);keywords.value=(rule.keywords || []).join(', ');keywords.required=true;keywords.placeholder='preço, valor, orçamento';
    const match=options('automation-rule-match-'+index,[{id:'contains',label:'Contém a palavra ou frase'},{id:'word',label:'Palavra ou frase inteira'}]);match.value=rule.match || 'word';
    const response=node('textarea','',undefined,'automation-rule-response-'+index);response.rows=3;response.maxLength=10000;response.required=true;response.value=rule.response || '';response.placeholder='Escreva a resposta automática…';
    section.append(heading,field('Nome',name),field('Palavras ou frases, separadas por vírgula',keywords),field('Comparação',match),field('Resposta enviada',response));
    const record={id:rule.id || crypto.randomUUID(),section,active,name,keywords,match,response,removed:false};ruleRows.push(record);$('automation-rules').append(section);return record;
  }
  function renderExecutions(rows) {
    const target=$('automation-executions');target.replaceChildren();
    const labels={queued:'Na fila',sending:'Envio iniciado',sent:'Respondido',uncertain:'Sem confirmação · confira a conversa',skipped_paused:'Pausado para atendimento manual',skipped_cooldown:'Intervalo por contato',skipped_disabled:'Robô desligado',skipped_changed:'Regra alterada',skipped_stopped:'Central encerrada'};
    for(const execution of rows.slice(0,30)) {
      const row=node('article','automation-execution'),contact=contacts.find(contact=>contact.jid===execution.jid) || hooks.getChats().find(contact=>contact.jid===execution.jid);
      row.append(node('strong','',contact?.name || execution.jid?.split('@')[0] || 'Contato'),node('span','',execution.ruleName || 'Regra'),node('span','execution-status',labels[execution.status] || 'Processado'),node('time','',formatDate(execution.updatedAt || execution.createdAt)));target.append(row);
    }
    if(!rows.length) target.append(node('p','feature-empty','Nenhuma execução registrada. O simulador não entra neste histórico.'));
  }
  async function refreshExecutions() {renderExecutions(await hooks.api('/automation/executions'));}
  async function openAutomation() {
    openDialog('automation-dialog');status('automation-status','Carregando regras…');
    await busy(null,async()=>{
      robotSettings=await hooks.api('/automation/settings');$('automation-cooldown').value=robotSettings.cooldownSeconds;ruleRows=[];$('automation-rules').replaceChildren();robotSettings.rules.forEach(addRule);renderRobotState();await refreshExecutions();status('automation-status',robotSettings.lastError || '',!!robotSettings.lastError);
    },'automation-status');
  }
  function buildAutomation() {
    const value=dialog('automation-dialog','Automações','Respostas por palavras-chave, do seu jeito. Salve as regras e teste antes de ativar.');
    const state=node('section','automation-state-card'),copy=node('div');copy.append(node('strong','feature-tag','','automation-state'),node('p','feature-description','','automation-enabled-since'));
    state.append(copy,button('Ativar robô',async()=>{
      if(!robotSettings) return;const toggle=$('automation-toggle');await busy(toggle,async()=>{robotSettings=await hooks.api('/automation/settings','PATCH',{enabled:!robotSettings.enabled});renderRobotState();status('automation-status',robotSettings.enabled?'Robô ativado para novas mensagens.':'Robô desligado.');},'automation-status');
    },'button primary','automation-toggle'));value.append(state,node('p','feature-description','A primeira regra que combinar responde uma vez. Grupos, histórico antigo, fotos e áudios são ignorados. Pause o robô por contato para assumir a conversa.'),node('p','feature-status','','automation-status'));
    const layout=node('div','automation-layout'),main=node('section'),form=node('form','',undefined,'automation-form'),cooldown=input('automation-cooldown','number');cooldown.min=10;cooldown.max=86400;cooldown.step=1;cooldown.required=true;cooldown.value=60;
    const save=button('Salvar regras',null,'button primary','automation-save');save.type='submit';
    form.append(field('Intervalo mínimo entre respostas ao mesmo contato (segundos)',cooldown),node('div','automation-rules',undefined,'automation-rules'));
    const actions=node('div','feature-actions');actions.append(button('＋ Adicionar regra',()=>addRule(),'button secondary','automation-add-rule'),save);form.append(actions);
    form.addEventListener('submit',async event=>{event.preventDefault();await busy(save,async()=>{
      const rules=ruleRows.filter(row=>!row.removed).map(row=>({id:row.id,name:row.name.value,keywords:row.keywords.value.split(',').map(value=>value.trim()).filter(Boolean),match:row.match.value,response:row.response.value,enabled:row.active.checked}));
      robotSettings=await hooks.api('/automation/settings','PATCH',{cooldownSeconds:Number(cooldown.value),rules});renderRobotState();status('automation-status','Regras salvas. '+(robotSettings.enabled?'O robô continua ativado.':'O robô continua desligado.'));
    },'automation-status');});main.append(node('h3','','Suas regras'),node('p','feature-description','Escreva palavras ou frases literais. A comparação ignora maiúsculas e acentos. A ordem das regras define a prioridade.'),form);
    const aside=node('aside','automation-side'),testForm=node('form','feature-card',undefined,'automation-test-form'),testText=node('textarea','',undefined,'automation-test-text');testText.rows=4;testText.required=true;testText.maxLength=10000;testText.placeholder='Digite uma mensagem que você receberia…';
    const testButton=button('Testar sem enviar',null,'button secondary','automation-test');testButton.type='submit';const testResult=node('p','automation-test-result','','automation-test-result');testResult.setAttribute('role','status');
    testForm.append(node('h3','','Teste sem WhatsApp'),node('p','feature-description','O teste usa as regras salvas e mostra a resposta aqui, sem enviar mensagem.'),field('Mensagem de teste',testText),testButton,testResult);
    testForm.addEventListener('submit',async event=>{event.preventDefault();await busy(testButton,async()=>{const result=await hooks.api('/automation/simulate','POST',{text:testText.value});$('automation-test-result').textContent=result.matched?'Regra: '+result.rule.name+'\n\n'+result.reply:'Nenhuma regra ativa combina com este texto.';},'automation-test-result');});
    const executions=node('section','feature-card'),head=node('div','feature-subheading');head.append(node('h3','','Execuções recentes'),button('Atualizar',()=>busy(null,refreshExecutions,'automation-status'),'text-button'));executions.append(head,node('div','automation-executions',undefined,'automation-executions'));aside.append(testForm,executions);layout.append(main,aside);value.append(layout);
  }
  function renderContactTools() {
    const target=$('contact-feature-tools');if(!target) return;target.hidden=!selected;if(!selected) return;
    const crm=details(selected);$('contact-crm-summary').textContent=(stages.length?stages:fallbackStages).find(stage=>stage.id===crm.stage)?.label || 'Novo';
    if(crm.followUpAt) $('contact-crm-summary').textContent+=' · '+formatDate(crm.followUpAt);
    $('contact-automation-pause').textContent=selected.automationPaused?'Retomar robô neste contato':'Pausar robô e assumir conversa';
    $('contact-automation-info').textContent=selected.automationPaused?'Robô pausado para este contato. Atendimento manual.':'Este contato segue a configuração global do robô.';
  }
  function buildContactTools() {
    const parent=$('contact-details');if(!parent) return;
    const section=node('section','contact-feature-tools',undefined,'contact-feature-tools');section.hidden=true;
    section.append(node('h3','','CRM e robô'),node('p','feature-description','','contact-crm-summary'),button('Organizar contato no CRM',()=>selected && openCrm(selected),'text-button','contact-crm-open'),button('Pausar robô e assumir conversa',async()=>{
      if(!selected) return;const contact=selected,version=selectionVersion;await busy($('contact-automation-pause'),async()=>{
        const detail=await hooks.api('/crm?jid='+encodeURIComponent(contact.jid),'PATCH',{automationPaused:!contact.automationPaused});mergeContact(detail);if(version===selectionVersion) renderContactTools();
      });
    },'button secondary full','contact-automation-pause'),node('p','feature-description','','contact-automation-info'));parent.append(section);
  }
  window.WhatsAppFeatures={
    init(options) {
      if(initialized) return;initialized=true;hooks=options;stages=fallbackStages;
      const nav=document.querySelector('.main-nav');
      if(nav) {
        const crm=button('',()=>openCrm(),'nav-item','nav-crm'),automation=button('',openAutomation,'nav-item','nav-automation');
        crm.append(node('span','icon feature-nav-icon','▦'),node('span','','CRM de contatos'));automation.append(node('span','icon feature-nav-icon','ϟ'),node('span','','Automações'));crm.title='CRM de contatos';automation.title='Automações';crm.setAttribute('aria-label','CRM de contatos');automation.setAttribute('aria-label','Automações');nav.append(crm,automation);
      }
      buildCrm();buildAutomation();buildContactTools();
    },
    onChats(chats) {
      if(!initialized) return;contacts=chats.map(chat=>{const previous=contacts.find(contact=>contact.jid===chat.jid);return {...previous,...chat,crm:chat.crm || previous?.crm};});
      refreshRobotStatus();
      if($('crm-dialog')?.open) renderBoard();
      if(selected) {const contact=contacts.find(contact=>contact.jid===selected.jid);if(contact) {selected={...selected,...contact,crm:contact.crm || selected.crm};renderContactTools();}}
    },
    async onSelectChat(chat) {
      if(!initialized) return;selected=chat;const version=++selectionVersion;renderContactTools();
      if(chat && !chat.crm) try {
        const result=await hooks.api('/crm');if(version!==selectionVersion) return;
        const contact=result.contacts?.find(contact=>contact.jid===chat.jid);if(contact) {stages=result.stages || stages;mergeContact(contact);renderContactTools();}
      } catch(error) {if(version===selectionVersion) hooks.notice(error.message);}
    }
  };
})();
