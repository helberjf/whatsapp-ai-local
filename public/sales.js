(() => {
  'use strict';
  // Vendas com IA: qualificação de leads, agenda de reuniões, Pix e contrato. A IA pede; a central confere e executa.
  const C=globalThis.WhatsAppCentral;if(!C) return;
  const {$,el,api}=C;
  const DAYS=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const KEY_HINTS={cpf:'Somente os 11 números do CPF.',cnpj:'Somente os 14 números do CNPJ.',email:'O e-mail cadastrado como chave.',phone:'Celular com DDD, por exemplo (11) 99999-8888.',random:'Chave aleatória, no formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.'};
  const ACTIONS={lead:'Lead qualificado',meeting:'Reunião agendada',pix:'Pix',contract:'Contrato',cancelled:'Cancelado',error:'Atenção'};
  let sales=null,contractFile,busy=false;
  const status=(text,error=false)=>{$('sales-status').textContent=text;$('sales-status').classList.toggle('error',error);};
  for(const [index,name] of DAYS.entries()) {const label=el('label','sales-day'),box=el('input');box.type='checkbox';box.id='sales-day-'+index;label.append(box,el('span','',name));$('sales-days').append(label);}

  function navState() {
    if(!sales) return;const active=[sales.qualify.enabled,sales.agenda.enabled,sales.pix.enabled,sales.contract.enabled].filter(Boolean).length;
    $('nav-sales-state').textContent=active?active+'/4':'—';$('nav-sales-state').title=active?`${active} de 4 recursos ligados`:'Vendas com IA desligadas';
  }
  function renderContractFile() {
    const file=contractFile===undefined?sales?.contract.file:contractFile;
    $('sales-contract-current').textContent=file?`Arquivo: ${file.fileName}${file.bytes?' · '+Math.max(1,Math.round(file.bytes/1024))+' KB':''}`:'Nenhum arquivo anexado.';
    $('sales-contract-remove').hidden=!file;
  }
  function renderLists() {
    const list=document.createDocumentFragment();
    for(const item of sales.appointments) {
      const row=el('li','log-entry sales-appointment'),chat=C.chats().find(entry=>entry.jid===item.jid),cancel=el('button','text-button','Cancelar');
      cancel.type='button';cancel.addEventListener('click',async()=>{
        if(!confirm('Cancelar este compromisso? O cliente não é avisado automaticamente.')) return;
        try {sales=await api('/sales/appointments?id='+encodeURIComponent(item.id),'DELETE');renderLists();status('Compromisso cancelado. Avise o cliente.');}catch(error) {status(error.message,true);}
      });
      row.append(el('strong','',item.label),el('span','',chat?.name || item.name || 'Contato'),cancel);list.append(row);
    }
    if(!sales.appointments.length) list.append(el('li','muted','Nenhum compromisso marcado.'));
    $('sales-appointments').replaceChildren(list);
    $('sales-next-slots').textContent=sales.agenda.enabled?(sales.nextSlots.length?'Próximos horários livres: '+sales.nextSlots.join(' · ')+'.':'Sem horários livres no período configurado.'):'Ligue a agenda e salve para ver os horários que a IA vai oferecer.';
    const log=document.createDocumentFragment();
    for(const entry of sales.log) {const chat=C.chats().find(item=>item.jid===entry.jid),row=el('li','log-entry');row.append(el('strong','',(chat?.name || 'Contato')+' · '+(ACTIONS[entry.action] || entry.action)),el('span','',entry.detail || ''),el('time','',C.dateTime(entry.at)));log.append(row);}
    if(!sales.log.length) log.append(el('li','muted','Ainda sem atividade.'));
    $('sales-log').replaceChildren(log);
  }
  function fill() {
    $('sales-qualify').checked=sales.qualify.enabled;
    const agenda=sales.agenda;$('sales-agenda').checked=agenda.enabled;$('sales-agenda-subject').value=agenda.subject;$('sales-agenda-start').value=agenda.start;$('sales-agenda-end').value=agenda.end;
    $('sales-agenda-slot').value=String(agenda.slotMinutes);$('sales-agenda-horizon').value=String(agenda.horizonDays);$('sales-agenda-note').value=agenda.note;
    DAYS.forEach((name,index)=>{$('sales-day-'+index).checked=agenda.days.includes(index);});
    const pix=sales.pix;$('sales-pix').checked=pix.enabled;$('sales-pix-type').value=pix.keyType;$('sales-pix-key').value=pix.key;$('sales-pix-name').value=pix.name;$('sales-pix-city').value=pix.city;$('sales-pix-description').value=pix.description;
    $('sales-pix-key-hint').textContent=KEY_HINTS[pix.keyType];
    const contract=sales.contract;$('sales-contract').checked=contract.enabled;$('sales-contract-message').value=contract.message;$('sales-contract-link').value=contract.link;
    contractFile=undefined;renderContractFile();renderLists();navState();
  }
  async function load() {
    status('Carregando…');
    try {sales=await api('/sales');fill();status('');}catch(error) {status(error.message,true);}
  }
  function collect() {
    return {
      qualify:{enabled:$('sales-qualify').checked},
      agenda:{enabled:$('sales-agenda').checked,subject:$('sales-agenda-subject').value,days:DAYS.map((name,index)=>index).filter(index=>$('sales-day-'+index).checked),start:$('sales-agenda-start').value,end:$('sales-agenda-end').value,slotMinutes:Number($('sales-agenda-slot').value),horizonDays:Number($('sales-agenda-horizon').value),note:$('sales-agenda-note').value},
      pix:{enabled:$('sales-pix').checked,keyType:$('sales-pix-type').value,key:$('sales-pix-key').value,name:$('sales-pix-name').value,city:$('sales-pix-city').value,description:$('sales-pix-description').value},
      contract:{enabled:$('sales-contract').checked,message:$('sales-contract-message').value,link:$('sales-contract-link').value.trim(),...(contractFile===undefined?{}:{file:contractFile})}
    };
  }
  async function save() {
    if(busy) return false;busy=true;$('sales-save').disabled=true;status('Salvando…');
    try {sales=await api('/sales','PUT',collect());fill();status('Vendas com IA salvas. Vale para as próximas mensagens.');return true;}
    catch(error) {status(error.message,true);return false;}
    finally {busy=false;$('sales-save').disabled=false;}
  }
  async function sendToOpenChat(kind,button) {
    const chat=C.selected?.(),jid=chat?.jid;
    if(!jid) {status('Abra antes a conversa que vai receber o envio.',true);return;}
    const name=chat?.name || 'esta conversa',amount=kind==='pix'?$('sales-pix-amount').value.trim():'';
    if(!confirm(kind==='pix'?`Enviar o código Pix${amount?' de R$ '+amount:' sem valor definido'} para ${name}?`:`Enviar o contrato para ${name}?`)) return;
    button.disabled=true;status('Enviando…');
    try {await api('/sales/send','POST',{jid,kind,...(amount?{amount}:{})},60000);status(kind==='pix'?'Código Pix enviado para '+name+'.':'Contrato enviado para '+name+'.');sales=await api('/sales');renderLists();await C.loadMessages?.();}
    catch(error) {status(error.message+' Confira a conversa antes de tentar de novo.',true);}
    finally {button.disabled=false;}
  }

  $('nav-sales').addEventListener('click',()=>{C.showView('page-sales','nav-sales');load();});
  $('sales-save').addEventListener('click',save);
  $('sales-pix-type').addEventListener('change',()=>{$('sales-pix-key-hint').textContent=KEY_HINTS[$('sales-pix-type').value];});
  $('sales-pix-test').addEventListener('click',async()=>{
    // O teste usa os dados salvos: salva primeiro para o código refletir o que está na tela.
    if(!await save()) return;
    try {const result=await api('/sales/pix/preview','POST',{amount:$('sales-pix-amount').value.trim()});$('sales-pix-code').value=result.code;$('sales-pix-code-box').hidden=false;status('Código de teste gerado. Cole no app do seu banco e confira o nome e o valor antes de pagar ou ligar a cobrança.');}
    catch(error) {status(error.message,true);}
  });
  $('sales-pix-copy').addEventListener('click',async()=>{try {await navigator.clipboard.writeText($('sales-pix-code').value);status('Código copiado.');}catch {$('sales-pix-code').select();status('Selecione e copie o código.');}});
  $('sales-pix-send').addEventListener('click',event=>sendToOpenChat('pix',event.currentTarget));
  $('sales-contract-send').addEventListener('click',event=>sendToOpenChat('contract',event.currentTarget));
  $('sales-contract-remove').addEventListener('click',()=>{contractFile=null;renderContractFile();status('O arquivo será removido ao salvar.');});
  $('sales-contract-file').addEventListener('change',()=>{
    const file=$('sales-contract-file').files?.[0];$('sales-contract-file').value='';if(!file) return;
    if(file.size>2*1024*1024) {status('Use um contrato de até 2 MB. Para arquivos maiores, informe o link de assinatura.',true);return;}
    const reader=new FileReader();
    reader.onload=()=>{contractFile={base64:String(reader.result).split(',')[1],mimeType:file.type || 'application/pdf',fileName:file.name,bytes:file.size};renderContractFile();status('Arquivo pronto. Salve para aplicar.');};
    reader.onerror=()=>status('Não foi possível ler o arquivo.',true);reader.readAsDataURL(file);
  });
  $('sales-open-assistant').addEventListener('click',()=>$('nav-ai').click());
  api('/sales').then(value=>{sales=value;navState();}).catch(()=>{});
})();
