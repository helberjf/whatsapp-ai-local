(() => {
  'use strict';
  // Fluxo de voz: transcrição automática → leitura pela IA → resposta em texto ou áudio. Também envia o texto do editor como áudio.
  const C=globalThis.WhatsAppCentral;if(!C) return;
  const {$,el,api,notice}=C;
  const OPENAI_VOICES=['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'];
  const FORMAT_HINTS={text:'A IA responde sempre por escrito.',audio:'A IA grava e envia cada resposta como mensagem de voz. Respostas longas (acima do limite) seguem em texto.',mirror:'Se o cliente mandou áudio, a IA responde em áudio; se mandou texto, responde em texto.'};
  let flow=null,previewUrl=null,speakBusy=false,assistantEnabled=null;
  const speakRequests=new Map();
  for(const voice of OPENAI_VOICES) {const option=el('option','',voice);option.value=voice;$('voice-openai-voice').append(option);}
  const format=()=>document.querySelector('input[name="voice-format"]:checked')?.value || 'text';
  function navState() {
    if(!flow) return;const active=[flow.autoTranscribe,flow.aiReadsAudio,flow.replyFormat!=='text'].filter(Boolean).length;
    $('nav-voice-state').textContent=active?active+'/3':'—';$('nav-voice-state').title=active?`${active} de 3 etapas ligadas`:'Fluxo de voz desligado';
  }
  function renderProviderFields() {const openai=$('voice-provider').value==='openai';$('voice-openai-fields').hidden=!openai;$('voice-windows-fields').hidden=openai;}
  function renderHints() {
    $('voice-format-hint').textContent=FORMAT_HINTS[format()];
    for(const [id,on] of [['voice-step-1',$('voice-auto-transcribe').checked],['voice-step-2',$('voice-ai-reads').checked],['voice-step-3',format()!=='text']]) $(id).classList.toggle('on',on);
    $('voice-speed-label').textContent=Number($('voice-speed').value).toLocaleString('pt-BR')+'×';
  }
  function renderSummary() {
    if(!flow) return;
    const steps=[flow.autoTranscribe?`áudios recebidos são transcritos (${flow.transcribeProvider==='ai'?'OpenAI':'Whisper local'})`:'transcrição automática desligada',flow.aiReadsAudio?'a IA lê as transcrições':'a IA ignora áudios',flow.replyFormat==='audio'?'respostas em áudio':flow.replyFormat==='mirror'?'responde no formato do cliente':'respostas em texto'];
    $('voice-summary').textContent='Agora: '+steps.join(' · ')+'.'+(assistantEnabled===false && (flow.aiReadsAudio || flow.replyFormat!=='text')?' As respostas automáticas estão desligadas em Assistente de IA: a IA só prepara rascunhos.':'');
    const fragment=document.createDocumentFragment();
    for(const entry of flow.log || []) {const chat=C.chats().find(item=>item.jid===entry.jid),row=el('li','log-entry');row.append(el('strong','',(chat?.name || 'Contato')+' · '+({transcribe:'Transcrição',fallback:'Enviado em texto',error:'Falha'}[entry.action] || entry.action)),el('span','',entry.detail || ''),el('time','',C.dateTime(entry.at)));fragment.append(row);}
    if(!flow.log?.length) fragment.append(el('li','muted','Ainda sem atividade.'));
    $('voice-log').replaceChildren(fragment);
  }
  function fill() {
    $('voice-auto-transcribe').checked=flow.autoTranscribe;$('voice-transcribe-provider').value=flow.transcribeProvider;$('voice-ai-reads').checked=flow.aiReadsAudio;
    for(const input of document.querySelectorAll('input[name="voice-format"]')) input.checked=input.value===flow.replyFormat;
    $('voice-provider').value=flow.speech.provider;$('voice-openai-voice').value=flow.speech.openaiVoice;$('voice-openai-model').value=flow.speech.openaiModel;$('voice-instructions').value=flow.speech.instructions || '';$('voice-speed').value=String(flow.speech.speed);
    if(flow.speech.voice && ![...$('voice-windows-voice').options].some(option=>option.value===flow.speech.voice)) {const option=el('option','',flow.speech.voice);option.value=flow.speech.voice;$('voice-windows-voice').append(option);}
    $('voice-windows-voice').value=flow.speech.voice || '';
    $('voice-openai-key-status').textContent=flow.openaiConfigured?'Chave da OpenAI configurada (a mesma da transcrição por IA).':'Nenhuma chave da OpenAI configurada.';
    $('voice-windows-hint').textContent=flow.windowsAvailable?'As vozes vêm de Configurações → Hora e idioma → Fala, no Windows.':'A voz do Windows só funciona com a central rodando no Windows. Neste computador, use a OpenAI.';
    renderProviderFields();renderHints();renderSummary();navState();
  }
  async function loadVoices() {
    try {
      const result=await api('/voice/voices'),select=$('voice-windows-voice'),current=select.value;
      select.replaceChildren(el('option','','Automática (português do Brasil)'));select.firstElementChild.value='';
      for(const voice of result.voices) {const option=el('option','',`${voice.name}${voice.culture?' · '+voice.culture:''}`);option.value=voice.name;select.append(option);}
      if(current && [...select.options].some(option=>option.value===current)) select.value=current;else if(flow?.speech.voice) select.value=flow.speech.voice;
    } catch {}
  }
  async function load() {
    $('voice-flow-status').textContent='Carregando…';
    try {
      [flow]=await Promise.all([api('/voice-flow'),loadVoices()]);
      assistantEnabled=await api('/assistant').then(value=>value.enabled).catch(()=>null);
      fill();$('voice-flow-status').textContent='';
    } catch(error) {$('voice-flow-status').textContent=error.message;}
  }
  function speechInput() {
    return {provider:$('voice-provider').value,voice:$('voice-windows-voice').value,openaiVoice:$('voice-openai-voice').value,openaiModel:$('voice-openai-model').value,speed:Number($('voice-speed').value),instructions:$('voice-instructions').value};
  }
  $('nav-voice').addEventListener('click',()=>{C.showView('page-voice','nav-voice');load();});
  $('voice-open-assistant').addEventListener('click',()=>$('nav-ai').click());
  for(const id of ['voice-auto-transcribe','voice-ai-reads','voice-speed']) $(id).addEventListener('input',renderHints);
  for(const input of document.querySelectorAll('input[name="voice-format"]')) input.addEventListener('change',renderHints);
  $('voice-provider').addEventListener('change',renderProviderFields);
  $('voice-save').addEventListener('click',async()=>{
    const key=$('voice-openai-key').value.trim(),input={autoTranscribe:$('voice-auto-transcribe').checked,transcribeProvider:$('voice-transcribe-provider').value,aiReadsAudio:$('voice-ai-reads').checked,replyFormat:format(),speech:speechInput(),...(key?{openaiApiKey:key}:{})};
    if(input.autoTranscribe && input.transcribeProvider==='ai' && !(flow?.autoTranscribe && flow.transcribeProvider==='ai') && !confirm('Com a transcrição por IA, cada áudio recebido será enviado à OpenAI e pode gerar cobrança na sua conta. Continuar?')) return;
    if(input.replyFormat!=='text' && input.speech.provider==='openai' && !(flow?.replyFormat!=='text' && flow?.speech.provider==='openai') && !confirm('As respostas em áudio com a OpenAI enviam o texto da resposta para a OpenAI gerar a voz. Continuar?')) return;
    $('voice-save').disabled=true;$('voice-flow-status').textContent='Salvando…';$('voice-openai-key').value='';
    try {flow=await api('/voice-flow','PUT',input);fill();$('voice-flow-status').textContent='Fluxo de voz salvo. Vale para as próximas mensagens.';}
    catch(error) {$('voice-flow-status').textContent=error.message;}
    finally {$('voice-save').disabled=false;}
  });
  function play(audio) {
    if(previewUrl) URL.revokeObjectURL(previewUrl);
    const bytes=Uint8Array.from(atob(audio.base64),char=>char.charCodeAt(0));previewUrl=URL.createObjectURL(new Blob([bytes],{type:audio.mimeType}));
    const player=$('voice-preview-player');player.src=previewUrl;player.hidden=false;player.play?.().catch(()=>{});
  }
  $('voice-test').addEventListener('click',async()=>{
    const text=$('voice-sample').value.trim();if(!text) return;
    // A prévia usa a voz salva; salve antes para ouvir uma voz diferente.
    $('voice-test').disabled=true;$('voice-flow-status').textContent='Gerando o áudio de exemplo…';
    try {if(flow && JSON.stringify(speechInput())!==JSON.stringify({...speechInput(),...flow.speech})) {flow=await api('/voice-flow','PUT',{speech:speechInput()});fill();}play(await api('/voice/preview','POST',{text},150000));$('voice-flow-status').textContent='Exemplo pronto.';}
    catch(error) {$('voice-flow-status').textContent=error.message;}
    finally {$('voice-test').disabled=false;}
  });

  // ---------- Enviar o texto do editor como mensagem de voz ----------
  $('speak-send').addEventListener('click',async()=>{
    const chat=C.selected(),text=C.draftText().trim();
    if(!chat) {notice('Abra uma conversa primeiro.');return;}
    if(!text) {notice('Escreva (ou peça à IA) o texto que será falado no áudio.');$('message-text').focus();return;}
    if(speakBusy || C.isSending()) return;
    const jid=chat.jid,quotedId=globalThis.WhatsAppExtras?.replyFor?.(jid) || undefined,key=jid+'|'+text+'|'+(quotedId || '');
    if(!speakRequests.has(key)) speakRequests.set(key,crypto.randomUUID());
    speakBusy=true;$('speak-send').disabled=true;$('send-status').textContent='Gerando a mensagem de voz…';
    try {
      await api('/voice/speak','POST',{jid,text,requestId:speakRequests.get(key),...(quotedId?{quotedId}:{})},180000);speakRequests.delete(key);
      if(C.selected()?.jid===jid && C.draftText().trim()===text) C.setDraftText('');
      globalThis.WhatsAppExtras?.onSent?.(jid);$('send-status').textContent='Mensagem de voz aceita pelo conector.';await C.loadMessages();
    } catch(error) {$('send-status').textContent=error.message+' Confira a conversa antes de tentar outro envio.';}
    finally {speakBusy=false;$('speak-send').disabled=false;}
  });
  api('/voice-flow').then(value=>{flow=value;navState();}).catch(()=>{});
})();
