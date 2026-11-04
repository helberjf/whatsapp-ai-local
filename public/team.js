(() => {
  'use strict';
  // Operação de equipe na tela: fila "Aguardando" com prazos, ações em massa, respostas rápidas com "/",
  // responsável por conversa, "Você é", painel de números e automações de equipe.
  const C=globalThis.WhatsAppCentral;if(!C) return;
  const {$,el,api,notice}=C;
  let settings=null,filter=null,selecting=false,range=1;const chosen=new Set();
  const store=(()=>{try {return globalThis.localStorage;}catch {return null;}})();
  const me=()=>{try {return store?.getItem('whats-ai:me') || '';}catch {return '';}};
  const setMe=value=>{try {store?.setItem('whats-ai:me',value);}catch {}};
  const normalize=text=>String(text || '').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
  const members=()=>settings?.members || [];
  const memberOf=id=>members().find(member=>member.id===id);
  const minutes=ms=>Math.max(0,Math.floor(ms/60_000));
  const duration=ms=>ms===null || ms===undefined?'—':ms<60_000?Math.max(1,Math.round(ms/1000))+' s':ms<3600_000?Math.round(ms/60_000)+' min':Math.floor(ms/3600_000)+' h '+String(Math.round(ms%3600_000/60_000)).padStart(2,'0');
  const initials=name=>String(name || '?').split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase();
  const waitingChats=list=>list.filter(chat=>Number.isFinite(chat.waitingSince) && chat.status!=='closed');

  // ---------- Lista: prazo de espera, responsável e seleção ----------
  function slaClass(since) {const waited=minutes(Date.now()-since),sla=settings?.sla || {warnMinutes:5,lateMinutes:15};return waited>=sla.lateMinutes?'sla-late':waited>=sla.warnMinutes?'sla-warn':'sla-ok';}
  function decorate(button,chat,title) {
    if(Number.isFinite(chat.waitingSince) && chat.status!=='closed') {
      const waited=Date.now()-chat.waitingSince,chip=el('span','wait-chip '+slaClass(chat.waitingSince),duration(waited));
      chip.title='Aguardando resposta há '+duration(waited);chip.setAttribute('aria-label',chip.title);title.append(chip);
    }
    const owner=memberOf(chat.assignee);
    if(owner) {const chip=el('span','assignee-chip',initials(owner.name));chip.style.background=owner.color;chip.title='Responsável: '+owner.name;chip.setAttribute('aria-label',chip.title);title.append(chip);}
    if(selecting) {
      const box=el('span','select-box'+(chosen.has(chat.jid)?' checked':''),chosen.has(chat.jid)?'✓':'');box.setAttribute('aria-hidden','true');
      button.prepend(box);button.setAttribute('aria-pressed',String(chosen.has(chat.jid)));button.classList.add('selectable');
    }
  }
  function onChatClick(chat) {
    if(!selecting) return false;
    if(chosen.has(chat.jid)) chosen.delete(chat.jid);else chosen.add(chat.jid);
    renderBulk();C.renderChats();return true;
  }
  function filterList(list) {
    if(filter==='waiting') return waitingChats(list).sort((a,b)=>a.waitingSince-b.waitingSince);
    if(filter==='mine') return list.filter(chat=>chat.assignee && chat.assignee===me() && chat.status!=='closed');
    return null;
  }
  function setTitle(text) {$('inbox-title').firstChild.textContent=text+' ';}
  function updateTabs() {
    const chats=C.chats().filter(chat=>chat.archived!==true),waiting=waitingChats(chats).length,mine=me()?chats.filter(chat=>chat.assignee===me() && chat.status!=='closed').length:0;
    $('filter-waiting-count').textContent=waiting;$('nav-waiting-count').textContent=waiting || '—';
    $('filter-mine').hidden=!me() || !memberOf(me());$('filter-mine-count').textContent=mine;
    for(const [id,name] of [['filter-waiting','waiting'],['filter-mine','mine']]) {$(id).classList.toggle('active',filter===name);$(id).setAttribute('aria-pressed',String(filter===name));}
  }
  function toggleFilter(name) {
    globalThis.WhatsAppExtras?.resetFilters?.();filter=filter===name?null:name;
    setTitle(filter==='waiting'?'Aguardando':filter==='mine'?'Minhas conversas':'Conversas');updateTabs();C.renderChats();
  }
  $('filter-waiting').addEventListener('click',()=>toggleFilter('waiting'));
  $('filter-mine').addEventListener('click',()=>toggleFilter('mine'));
  // O tempo passa mesmo sem mudança nos dados: as cores de prazo são atualizadas a cada 30 s.
  setInterval(()=>{if(C.chats().some(chat=>chat.waitingSince)) C.renderChats();},30_000);
  C.hooks.sync.push(()=>{updateTabs();renderAssignee();});

  // ---------- Ações em massa ----------
  function renderBulk() {
    $('bulk-bar').hidden=!selecting;$('bulk-toggle').setAttribute('aria-pressed',String(selecting));
    $('bulk-count').textContent=chosen.size===1?'1 selecionada':chosen.size+' selecionadas';
    for(const button of document.querySelectorAll('[data-bulk]')) button.disabled=!chosen.size;
  }
  function setSelecting(value) {selecting=value;if(!value) chosen.clear();renderBulk();C.renderChats();}
  $('bulk-toggle').addEventListener('click',()=>setSelecting(!selecting));
  $('bulk-cancel').addEventListener('click',()=>setSelecting(false));
  $('bulk-visible').addEventListener('click',()=>{
    const visible=[...document.querySelectorAll('#chat-list .chat-item')].length;
    // Seleciona o que o filtro atual mostra (inclusive linhas fora da tela em listas grandes).
    const search=normalize($('search').value.trim());
    const base=C.chats().filter(chat=>!search || normalize(`${chat.name} ${chat.phone || ''} ${chat.jid} ${(chat.labels || []).join(' ')}`).includes(search));
    const list=globalThis.WhatsAppExtras?.arrangeChats?.(base) || base;
    for(const chat of list.slice(0,200)) chosen.add(chat.jid);
    renderBulk();C.renderChats();if(list.length>200) notice('Selecionadas as primeiras 200 conversas (limite por ação).');else if(!visible) notice('Nenhuma conversa visível para selecionar.');
  });
  let bulkAction=null;
  async function runBulk(action,value) {
    const jids=[...chosen];if(!jids.length) return;
    for(const button of document.querySelectorAll('[data-bulk]')) button.disabled=true;
    try {
      const result=await api('/chats/bulk','POST',{jids,action,...(value!==undefined?{value}:{})},180_000);
      notice(result.failed?.length?`${result.updated} conversa(s) atualizada(s). ${result.failed.length} com falha: ${result.failed[0].error}`:`${result.updated} conversa(s) atualizada(s).`,!result.failed?.length);
      setSelecting(false);await C.sync();
    } catch(error) {notice(error.message);renderBulk();}
  }
  for(const button of document.querySelectorAll('[data-bulk]')) button.addEventListener('click',()=>{
    const action=button.dataset.bulk;
    if(action==='label' || action==='assign') {
      bulkAction=action;$('bulk-error').textContent='';
      $('bulk-label-field').hidden=action!=='label';$('bulk-remove-field').hidden=action!=='label';$('bulk-assign-field').hidden=action!=='assign';
      const labels=[...new Set(C.chats().flatMap(chat=>chat.labels || []))].sort();$('bulk-labels').replaceChildren(...labels.map(label=>{const option=el('option');option.value=label;return option;}));
      const select=$('bulk-assign');select.replaceChildren(el('option','','Sem responsável'),...members().map(member=>{const option=el('option','',member.name);option.value=member.id;return option;}));select.firstElementChild.value='';
      $('bulk-dialog-title').textContent=action==='label'?'Etiqueta nas selecionadas':'Responsável pelas selecionadas';$('bulk-dialog').showModal();return;
    }
    if(action==='close' && !confirm(`Concluir ${chosen.size} conversa(s)?`+(settings?.survey?.enabled?' A pesquisa de satisfação será enviada a cada uma (no máximo uma por dia por contato).':''))) return;
    runBulk(action);
  });
  $('bulk-form').addEventListener('submit',async event=>{
    event.preventDefault();
    if(bulkAction==='label') {const label=$('bulk-label').value.trim();if(!label) {$('bulk-error').textContent='Escreva a etiqueta.';return;}$('bulk-dialog').close();await runBulk($('bulk-remove').checked?'unlabel':'label',label);}
    else {$('bulk-dialog').close();await runBulk('assign',$('bulk-assign').value || null);}
  });

  // ---------- Respostas rápidas com "/" no editor ----------
  let slash={open:false,items:[],index:0,start:0};
  function closeSlash() {slash.open=false;$('slash-menu').hidden=true;$('message-text').removeAttribute('aria-activedescendant');}
  function contactFirstName() {const chat=C.selected();return chat && chat.nameSource!=='number' && !/^[\d+\s().-]+$/.test(chat.name || '')?String(chat.name).trim().split(/\s+/)[0]:'você';}
  function renderSlash() {
    const menu=$('slash-menu');menu.replaceChildren();
    slash.items.forEach((template,index)=>{
      const item=el('div','slash-item'+(index===slash.index?' active':''));item.id='slash-item-'+index;item.setAttribute('role','option');item.setAttribute('aria-selected',String(index===slash.index));
      item.append(el('strong','',template.name),el('span','',template.body));
      item.addEventListener('mousedown',event=>{event.preventDefault();slash.index=index;insertSlash();});menu.append(item);
    });
    menu.hidden=false;$('message-text').setAttribute('aria-activedescendant','slash-item-'+slash.index);
  }
  function updateSlash() {
    const editor=$('message-text'),before=editor.value.slice(0,editor.selectionStart ?? editor.value.length),match=before.match(/(^|\n)\/([^\s/]{0,30})$/);
    if(!match || !C.selected()) {closeSlash();return;}
    const query=normalize(match[2]),templates=C.templates() || [];
    slash.items=templates.filter(template=>!query || normalize(template.name+' '+template.body).includes(query)).slice(0,8);
    slash.start=before.length-match[2].length-1;slash.index=Math.min(slash.index,Math.max(0,slash.items.length-1));
    if(!slash.items.length) {closeSlash();return;}slash.open=true;renderSlash();
  }
  function insertSlash() {
    const template=slash.items[slash.index];if(!template) return closeSlash();
    const editor=$('message-text'),end=editor.selectionStart ?? editor.value.length,body=template.body.replace(/\{(?:nome|name)\}/g,contactFirstName());
    editor.value=editor.value.slice(0,slash.start)+body+editor.value.slice(end);const caret=slash.start+body.length;editor.setSelectionRange?.(caret,caret);
    closeSlash();C.touchDraft();editor.focus();
  }
  $('message-text').addEventListener('input',()=>{slash.index=0;updateSlash();});
  $('message-text').addEventListener('blur',()=>setTimeout(closeSlash,120));
  // Captura antes do Enter que envia: com o menu aberto, Enter/Tab inserem a resposta.
  $('composer').addEventListener('keydown',event=>{
    if(!slash.open || event.target.id!=='message-text') return;
    if(event.key==='ArrowDown' || event.key==='ArrowUp') {event.preventDefault();slash.index=(slash.index+(event.key==='ArrowDown'?1:-1)+slash.items.length)%slash.items.length;renderSlash();}
    else if(event.key==='Enter' || event.key==='Tab') {event.preventDefault();event.stopImmediatePropagation();insertSlash();}
    else if(event.key==='Escape') {event.preventDefault();closeSlash();}
  },true);

  // ---------- Responsável pela conversa e "Você é" ----------
  function renderMembersSelects() {
    const select=$('me-member'),current=me();
    select.replaceChildren(el('option','','Escolher atendente…'),...members().map(member=>{const option=el('option','',member.name);option.value=member.id;return option;}));select.firstElementChild.value='';
    select.hidden=!members().length;select.value=memberOf(current)?current:'';
    $('me-name').textContent=memberOf(current)?.name || 'Uso pessoal';
    const assignee=$('chat-assignee');assignee.replaceChildren(el('option','','Sem responsável'),...members().map(member=>{const option=el('option','',member.name);option.value=member.id;return option;}));assignee.firstElementChild.value='';
    $('chat-assignee-hint').textContent=members().length?'Trocar o responsável registra uma nota interna de transferência.':'Cadastre atendentes em Equipe e painel.';
    renderAssignee();
  }
  function renderAssignee() {const chat=C.selected();if(!chat) return;const current=C.chats().find(item=>item.jid===chat.jid) || chat;$('chat-assignee').value=memberOf(current.assignee)?current.assignee:'';$('chat-assignee').disabled=!members().length;}
  $('me-member').addEventListener('change',()=>{setMe($('me-member').value);$('me-name').textContent=memberOf(me())?.name || 'Uso pessoal';updateTabs();if(filter==='mine') C.renderChats();});
  $('chat-assignee').addEventListener('change',async()=>{
    const chat=C.selected();if(!chat) return;const jid=chat.jid,previous=C.chats().find(item=>item.jid===jid)?.assignee || chat.assignee || null,next=$('chat-assignee').value || null;
    try {
      const saved=await api('/contact?jid='+encodeURIComponent(jid),'PATCH',{assignee:next});
      for(const target of [C.chats().find(item=>item.jid===jid),chat]) if(target) target.assignee=saved.assignee;
      if(previous!==next) {
        const by=memberOf(me())?.name,text=`Transferida de ${memberOf(previous)?.name || 'sem responsável'} para ${memberOf(next)?.name || 'sem responsável'}`+(by?` por ${by}`:'')+'.';
        await api('/notes','POST',{jid,text}).catch(()=>{});if(C.selected()?.jid===jid) await C.reloadContact?.().catch(()=>{});
      }
      C.renderChats();updateTabs();notice(next?'Responsável: '+memberOf(next)?.name+'.':'Conversa sem responsável.',true);
    } catch(error) {notice(error.message);renderAssignee();}
  });
  C.hooks.open.push(()=>renderAssignee());

  // ---------- Painel de números ----------
  function tile(label,value,detail,tone) {const box=el('div','kpi'+(tone?' '+tone:''));box.append(el('span','kpi-label',label),el('strong','kpi-value',value),el('small','kpi-detail',detail || ''));return box;}
  const percent=(part,total)=>total?Math.round(part/total*100)+'%':'—';
  function renderKpis(data) {
    const t=data.totals,s=data.surveys,n=data.now,label=range===1?'hoje':`nos últimos ${range} dias`;
    $('team-kpis').replaceChildren(
      tile('Aguardando agora',String(n.waiting),n.oldestWaitMs!==null?'maior espera: '+duration(n.oldestWaitMs):'ninguém esperando',n.oldestWaitMs!==null && n.oldestWaitMs>=(settings?.sla?.lateMinutes || 15)*60_000?'tone-late':''),
      tile('Entradas',String(t.incoming),label),
      tile('Tempo médio da 1ª resposta',duration(t.averageResponseMs),t.responses?`${percent(t.onTime,t.responses)} dentro do prazo de ${settings?.sla?.lateMinutes || 15} min`:'sem respostas no período'),
      tile('Respondidas por IA e robôs',percent(t.auto,t.responses),`${t.auto} de ${t.responses} · pessoas: ${t.human}`),
      tile('Passagens para pessoas',String(t.handoffs+t.unanswered),`${t.handoffs} pedidos de atendente · ${t.unanswered} sem resposta a tempo`),
      tile('Satisfação',s.satisfaction===null?'—':s.satisfaction+'%',s.sent?`${s.answered} de ${s.sent} responderam · Ótimo ou Bom`:'pesquisa não enviada no período'),
      tile('Concluídas',String(t.closed),t.triaged?`${t.triaged} triadas pela IA`:label)
    );
  }
  // Colunas finas, uma série (sem legenda), eixo discreto; a dica mostra o valor exato e há uma tabela acessível.
  function renderHours(hours) {
    const box=$('hours-chart'),width=Math.max(320,box.clientWidth || 640),height=180,left=34,bottom=22,top=10,plot=width-left-8,band=plot/24,bar=Math.min(24,band-2),max=Math.max(1,...hours);
    const step=max<=4?1:Math.ceil(max/4),ceiling=Math.ceil(max/step)*step,y=value=>top+(height-top-bottom)*(1-value/ceiling),ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('class','hours-svg');svg.setAttribute('role','img');
    svg.setAttribute('aria-label',`Entradas por hora; pico de ${max} às ${hours.indexOf(max)}h.`);
    const node=(tag,attrs,text)=>{const item=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attrs)) item.setAttribute(key,value);if(text!==undefined) item.textContent=text;return item;};
    for(let value=0;value<=ceiling;value+=step) {svg.append(node('line',{x1:left,x2:width-8,y1:y(value),y2:y(value),class:'grid-line'}),node('text',{x:left-6,y:y(value)+3,class:'axis-label','text-anchor':'end'},String(value)));}
    hours.forEach((value,hour)=>{
      const x=left+hour*band+(band-bar)/2,h=Math.max(0,y(0)-y(value)),r=Math.min(4,bar/2,h);
      if(value>0) svg.append(node('path',{d:`M${x},${y(0)} V${y(0)-h+r} Q${x},${y(0)-h} ${x+r},${y(0)-h} H${x+bar-r} Q${x+bar},${y(0)-h} ${x+bar},${y(0)-h+r} V${y(0)} Z`,class:'hour-bar'}));
      const hit=node('rect',{x:left+hour*band,y:top,width:band,height:height-top-bottom,class:'hour-hit','data-hour':hour,'data-value':value});svg.append(hit);
      if(hour%3===0) svg.append(node('text',{x:left+hour*band+band/2,y:height-6,class:'axis-label','text-anchor':'middle'},hour+'h'));
    });
    const tip=$('hours-tooltip');
    svg.addEventListener('pointermove',event=>{const target=event.target.closest?.('.hour-hit');if(!target) {tip.hidden=true;return;}const hour=Number(target.dataset.hour),value=Number(target.dataset.value);tip.textContent=`${String(hour).padStart(2,'0')}h–${String(hour+1).padStart(2,'0')}h · ${value} entrada${value===1?'':'s'}`;const rect=box.getBoundingClientRect();tip.style.left=Math.min(rect.width-140,Math.max(0,event.clientX-rect.left+12))+'px';tip.style.top=Math.max(0,event.clientY-rect.top-34)+'px';tip.hidden=false;});
    svg.addEventListener('pointerleave',()=>{tip.hidden=true;});
    box.replaceChildren(svg);
    $('hours-table').querySelector('tbody').replaceChildren(...hours.map((value,hour)=>{const row=el('tr');row.append(el('td','',hour+'h'),el('td','',String(value)));return row;}));
    $('hours-caption').textContent=(range===1?'Hoje':`Soma dos últimos ${range} dias`)+': conversas que começaram a esperar resposta, pela hora de chegada.';
  }
  function renderMembersTable(data) {
    const rows=data.members.map(member=>{const row=el('tr'),name=el('td'),dot=el('span','member-dot');dot.style.background=member.color;name.append(dot,el('span','',member.name));row.append(name,el('td','',String(member.assigned)),el('td','',String(member.responses)),el('td','',duration(member.averageMs)),el('td','',String(member.closed)));return row;});
    if(!rows.length) {const row=el('tr'),cell=el('td','muted','Cadastre atendentes abaixo para ver os números de cada um.');cell.colSpan=5;row.append(cell);rows.push(row);}
    $('members-body').replaceChildren(...rows);
  }
  async function loadMetrics() {
    try {const data=await api('/team/metrics?days='+range);renderKpis(data);renderHours(data.hours);renderMembersTable(data);}
    catch(error) {notice(error.message);}
  }

  // ---------- Configurações da equipe ----------
  let draftMembers=[];
  function renderMembersEditor() {
    const list=$('members-list');list.replaceChildren();
    draftMembers.forEach((member,index)=>{
      const row=el('div','member-row'),dot=el('span','member-dot'),name=el('input'),remove=el('button','text-button','Remover');
      dot.style.background=member.color || '#00a98d';name.value=member.name;name.maxLength=40;name.setAttribute('aria-label','Nome do atendente');remove.type='button';
      name.addEventListener('input',()=>{member.name=name.value;});remove.addEventListener('click',()=>{draftMembers.splice(index,1);renderMembersEditor();});
      row.append(dot,name,remove);list.append(row);
    });
    if(!draftMembers.length) list.append(el('p','muted small','Nenhum atendente cadastrado.'));
  }
  function fillSettings() {
    draftMembers=members().map(member=>({...member}));renderMembersEditor();
    $('sla-warn').value=settings.sla.warnMinutes;$('sla-late').value=settings.sla.lateMinutes;
    $('triage-enabled').checked=settings.triage.enabled;$('triage-categories').value=settings.triage.categories.join('\n');
    $('notice-enabled').checked=settings.queueNotice.enabled;$('notice-after').value=settings.queueNotice.afterSeconds;$('notice-cooldown').value=settings.queueNotice.cooldownHours;$('notice-text').value=settings.queueNotice.text;
    $('survey-enabled').checked=settings.survey.enabled;$('survey-question').value=settings.survey.question;
  }
  async function loadSettings() {const result=await api('/team');settings=result.settings;$('survey-options').textContent='Opções enviadas: '+result.surveyOptions.join(' · ');renderMembersSelects();updateTabs();C.renderChats();return settings;}
  $('member-add').addEventListener('submit',event=>{event.preventDefault();const name=$('member-name').value.trim();if(!name) return;draftMembers.push({name});$('member-name').value='';renderMembersEditor();});
  $('team-save-members').addEventListener('click',async()=>{
    $('team-save-members').disabled=true;$('members-status').textContent='Salvando…';
    try {settings=(await api('/team','PUT',{members:draftMembers.map(member=>({...(member.id?{id:member.id}:{}),name:member.name,...(member.color?{color:member.color}:{})})),sla:{warnMinutes:Number($('sla-warn').value),lateMinutes:Number($('sla-late').value)}})).settings;fillSettings();renderMembersSelects();$('members-status').textContent='Atendentes e prazos salvos.';loadMetrics();}
    catch(error) {$('members-status').textContent=error.message;}finally {$('team-save-members').disabled=false;}
  });
  $('team-save-automations').addEventListener('click',async()=>{
    const turningOn=[['notice-enabled',settings?.queueNotice.enabled,'O aviso de fila envia mensagens automáticas aos clientes que esperam.'],['survey-enabled',settings?.survey.enabled,'A pesquisa será enviada aos clientes quando uma conversa for concluída.'],['triage-enabled',settings?.triage.enabled,'A triagem envia as últimas mensagens de texto do cliente ao provedor de IA.']].filter(([id,before])=>$(id).checked && !before);
    if(turningOn.length && !confirm(turningOn.map(item=>item[2]).join('\n')+'\n\nLigar agora?')) return;
    $('team-save-automations').disabled=true;$('automations-status').textContent='Salvando…';
    try {
      settings=(await api('/team','PUT',{triage:{enabled:$('triage-enabled').checked,categories:$('triage-categories').value.split('\n').map(item=>item.trim()).filter(Boolean)},queueNotice:{enabled:$('notice-enabled').checked,afterSeconds:Number($('notice-after').value),cooldownHours:Number($('notice-cooldown').value),text:$('notice-text').value},survey:{enabled:$('survey-enabled').checked,question:$('survey-question').value}})).settings;
      fillSettings();$('automations-status').textContent='Automações salvas. Valem a partir das próximas mensagens.';
    } catch(error) {$('automations-status').textContent=error.message;}finally {$('team-save-automations').disabled=false;}
  });
  for(const input of document.querySelectorAll('input[name="team-range"]')) input.addEventListener('change',()=>{range=Number(input.value);loadMetrics();});
  $('team-refresh').addEventListener('click',loadMetrics);
  $('nav-team').addEventListener('click',async()=>{C.showView('page-team','nav-team');try {await loadSettings();fillSettings();}catch(error) {notice(error.message);}loadMetrics();});

  globalThis.WhatsAppTeam={filter:filterList,decorate,onChatClick,resetFilter:()=>{if(!filter) return;filter=null;setTitle('Conversas');updateTabs();C.renderChats();},selecting:()=>selecting};
  loadSettings().catch(()=>{});renderBulk();
})();
