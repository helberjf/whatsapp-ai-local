const {test:base,expect}=require('@playwright/test');
const path=require('node:path');
const {createDemo,wave}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});
const screenshotDir=path.join(__dirname,'..','..','docs','screenshots');
const capturePath=name=>process.env.WHATSAPP_CAPTURE_DOCS==='1'?path.join(screenshotDir,name):test.info().outputPath(name);
async function openChat(page) {await page.locator('.chat-item').filter({hasText:'Alex Morgan'}).click();await expect(page.locator('#conversation-content')).toBeVisible();}
async function insideViewport(locator) {await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();expect(box).not.toBeNull();const viewport=locator.page().viewportSize();expect(box.x).toBeGreaterThanOrEqual(-1);expect(box.y).toBeGreaterThanOrEqual(-1);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width+1);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height+1);}
test('opening an unread conversation stays read after refresh',async({page})=>{
  await page.locator('.chat-item').filter({hasText:'Sam Rivera'}).click();await expect(page.locator('.chat-item').filter({hasText:'Sam Rivera'}).locator('.unread-count')).toHaveCount(0);
  await page.locator('#refresh-top').click();await expect(page.locator('.chat-item').filter({hasText:'Sam Rivera'}).locator('.unread-count')).toHaveCount(0);
});
test('reply menu quotes the selected message and sends its identifier',async({page})=>{
  await openChat(page);const message=page.locator('.message').filter({hasText:'Maneiro'});await message.locator('.message-menu-toggle').click();await message.getByRole('button',{name:'Responder',exact:true}).click();
  await expect(page.locator('#reply-bar')).toContainText('Maneiro');await page.screenshot({path:path.join(__dirname,'..','..','data','reply-preview.png')});await page.locator('#message-text').fill('Respondendo a esta mensagem');
  const request=page.waitForRequest(req=>req.url().endsWith('/api/send') && req.method()==='POST');await page.locator('#send').click();expect((await request).postDataJSON().quotedId).toBe('demo-short');await expect(page.locator('#reply-bar')).toBeHidden();await expect(page.locator('.message.mine .message-quote')).toContainText('Maneiro');
});
test('composer sends dictated text or a view-once audio from the media preview',async({page})=>{
  await openChat(page);
  const once=page.locator('#voice-view-once'),sendAsText=page.getByRole('button',{name:'Enviar como texto'});
  const input=page.locator('#attachment'),audio={name:'sample.wav',mimeType:'audio/wav',buffer:wave()};
  await expect(once).toBeHidden();await expect(sendAsText).toBeHidden();
  await input.setInputFiles(audio);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    const panel=await page.locator('#voice-recorder').boundingBox();
    const cancel=await page.locator('#voice-cancel').boundingBox();
    expect(panel.x+panel.width-cancel.x-cancel.width).toBeLessThanOrEqual(10);
    await insideViewport(sendAsText);
  }
  await page.setViewportSize({width:1440,height:960});
  await page.locator('#message-text').fill('Rascunho separado');
  await sendAsText.click();
  const rows=page.locator('.message.mine');
  const preview=page.getByRole('dialog',{name:'Prévia da transcrição'});
  await expect(preview.getByRole('textbox')).toHaveValue('Transcrição automática de demonstração');
  await expect(rows.filter({hasText:'Transcrição automática de demonstração'})).toHaveCount(0);
  await preview.getByRole('button',{name:'Cancelar'}).click();
  await expect(preview).toBeHidden();
  await expect(page.locator('#voice-preview')).toBeVisible();
  await sendAsText.click();
  await expect(preview).toBeVisible();
  await preview.getByRole('textbox').fill('Texto revisado antes de enviar');
  await preview.getByRole('button',{name:'Enviar texto'}).click();
  await expect(rows.filter({hasText:'Texto revisado antes de enviar'})).toBeVisible();
  await expect(page.locator('#message-text')).toHaveValue('Rascunho separado');
  await expect(once).toBeHidden();
  await input.setInputFiles(audio);
  await expect(once).toHaveAttribute('aria-pressed','false');
  await once.click();
  await expect(once).toHaveAttribute('aria-pressed','true');
  await page.locator('#voice-send').click();
  const media=rows.filter({hasText:'Áudio de visualização única'});
  await expect(media).toBeVisible();
  await expect(media.locator('.view-once-badge')).toHaveText('1');
  await expect(media.locator('.audio-load')).toHaveCount(0);
  await expect(once).toBeHidden();
  await input.setInputFiles(audio);
  await expect(once).toHaveAttribute('aria-pressed','false');
  await input.setInputFiles({name:'photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK9sAAAAASUVORK5CYII=','base64')});
  const photoOnce=page.locator('#attachment-view-once');
  await expect(once).toBeHidden();await expect(photoOnce).toHaveAttribute('aria-pressed','false');
  await photoOnce.click();await page.locator('#send').click();
  await expect(rows.filter({hasText:'Foto de visualização única'})).toBeVisible();
  await expect(photoOnce).toBeHidden();
});
test.beforeEach(async({page,demo})=>{const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item'),()=>JSON.stringify(errors)).toHaveCount(10);expect(errors).toEqual([]);});

for(const viewport of [{width:1440,height:960},{width:1133,height:637},{width:390,height:844}]) {
  test(`navigation and composer remain reachable at ${viewport.width}x${viewport.height}`,async({page})=>{
    await page.setViewportSize(viewport);
    for(const locator of await page.locator('.main-nav button').all()) await insideViewport(locator);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await openChat(page);for(const id of ['message-text','emoji-toggle','attachment-toggle','record-audio','send']) await insideViewport(page.locator('#'+id));
    await page.locator('#emoji-toggle').click();await expect(page.locator('#emoji-dialog')).toBeVisible();await page.getByRole('button',{name:'Feliz',exact:true}).click();await expect(page.locator('#message-text')).toHaveValue('😊');
    await page.locator('#show-contact').click();await expect(page.locator('#contact-info-open')).toBeVisible();await insideViewport(page.locator('#contact-info-open'));
  });
}
test('media players, safe links and draft survive polling',async({page})=>{
  await page.setViewportSize({width:1536,height:1100});
  await openChat(page);await page.locator('#message-text').fill('Rascunho preservado');
  await expect(page.locator('.message-link')).toHaveCount(2);await expect(page.locator('.message-link').first()).toHaveAttribute('rel','noopener noreferrer');
  await expect(page.locator('.audio-player')).toHaveAttribute('src',/^blob:/);await expect(page.locator('.audio-card')).toHaveClass(/ready/);await page.locator('.audio-player').evaluate(async node=>{await node.play();node.pause();node.currentTime=1;});
  await page.locator('.audio-rate',{hasText:'1,5×'}).click();await expect(page.locator('.audio-rate',{hasText:'1,5×'})).toHaveAttribute('aria-pressed','true');expect(await page.locator('.audio-player').evaluate(node=>node.playbackRate)).toBe(1.5);
  const rates=await page.locator('.audio-rate').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().top));expect(Math.max(...rates)-Math.min(...rates)).toBeLessThan(2);
  await page.locator('.audio-play').click();await expect(page.locator('.audio-play')).toHaveAttribute('aria-label','Pausar áudio');await page.locator('.audio-play').click();await expect(page.locator('.audio-play')).toHaveAttribute('aria-label','Reproduzir áudio');
  await page.locator('.video-load').click();await expect(page.locator('video')).toHaveAttribute('src',/^blob:/);await page.locator('video').evaluate(async node=>{await node.play();node.pause();node.currentTime=1;});
  await page.locator('#refresh-top').click();await expect.poll(()=>page.locator('video').evaluate(node=>node.currentTime)).toBeGreaterThan(.8);await expect(page.locator('#message-text')).toHaveValue('Rascunho preservado');
  await page.screenshot({path:capturePath('media.png')});
});
test('trigger editor saves against the real service and remains disabled until opted in',async({page})=>{
  await page.locator('#nav-triggers').click();await expect(page.locator('#triggers-dialog')).toBeVisible();await page.locator('#trigger-new').click();
  await page.locator('#trigger-name').fill('Boas-vindas');await page.locator('.trigger-message-text').first().fill('Olá, {nome}! Obrigado pelo contato.');
  await insideViewport(page.locator('#trigger-save'));await page.screenshot({path:capturePath('triggers.png')});await page.locator('#trigger-save').click();
  await expect(page.locator('#trigger-editor-dialog')).not.toBeVisible();await expect(page.locator('#triggers-list')).toContainText('Boas-vindas');await expect(page.locator('#triggers-enabled')).not.toBeChecked();
});
test('contact details, disappearing options and deletion are explicit',async({page})=>{
  await openChat(page);await page.locator('#show-contact').click();await page.locator('#contact-info-open').click();await expect(page.locator('#contact-info-data')).toContainText('Alex Morgan');await page.getByRole('button',{name:'Fechar dados do contato'}).click();
  await page.locator('#disappearing-open').click();await expect(page.locator('#disappearing-save')).toBeEnabled();await page.locator('#disappearing-expiration').selectOption('86400');await page.locator('#disappearing-save').click();await expect(page.locator('#disappearing-dialog')).not.toBeVisible();await page.locator('#hide-contact').click();
  const own=page.locator('.message.mine').filter({hasText:'Conheça o catálogo'});await own.locator('.message-menu-toggle').click();await own.getByRole('button',{name:'Apagar para todos'}).click();await expect(page.locator('#delete-dialog')).toBeVisible();await expect(own).toContainText('Conheça o catálogo');await page.locator('#delete-confirm').click();await expect(page.locator('.message-deleted')).toContainText('Mensagem apagada');
});
test('conversation gains space and global search opens from the sidebar',async({page})=>{
  await page.setViewportSize({width:1440,height:960});await openChat(page);
  await expect(page.locator('.topbar')).toHaveCount(0);await expect(page.locator('#contact-panel')).not.toBeVisible();
  const workspace=await page.locator('#workspace').boundingBox(),conversation=await page.locator('.conversation').boundingBox();expect(conversation.width/workspace.width).toBeGreaterThan(.65);expect(conversation.height).toBeGreaterThan(750);
  await page.locator('#global-search-open').click();await page.locator('#global-search').fill('Studio');await expect(page.locator('#global-results')).toContainText('Studio Headphones');await page.getByRole('button',{name:/Studio Headphones/}).click();await expect(page.locator('#global-search-dialog')).not.toBeVisible();
});
test('image and PDF open inside the app and close back to the same draft',async({page})=>{
  await openChat(page);await page.locator('#message-text').fill('Meu rascunho');const url=page.url();
  await page.getByRole('button',{name:'Abrir imagem',exact:true}).click();await expect(page.locator('#media-viewer')).toBeVisible();await expect(page.locator('#media-viewer img')).toHaveJSProperty('naturalWidth',1);await page.locator('#media-zoom').click();await expect(page.locator('#media-viewer')).toHaveClass(/zoomed/);await page.keyboard.press('Escape');await expect(page.locator('#media-viewer')).not.toBeVisible();
  await page.getByRole('button',{name:'Abrir PDF',exact:true}).click();await expect(page.locator('#pdf-canvas')).toBeVisible();await expect(page.locator('#pdf-page-text')).toContainText('Whats AI - Sample document');await expect(page.locator('#pdf-page-count')).toHaveText('Página 1 de 2');await page.locator('#pdf-next').click();await expect(page.locator('#pdf-page-text')).toContainText('Second sample page');await page.locator('#pdf-previous').click();await expect(page.locator('#pdf-page-text')).toContainText('Whats AI - Sample document');await page.locator('#pdf-zoom-in').click();await expect(page.locator('#pdf-zoom-label')).toHaveText('125%');await page.locator('#pdf-zoom-out').click();await expect(page.locator('#pdf-zoom-label')).toHaveText('100%');await insideViewport(page.locator('#media-viewer-close'));await page.screenshot({path:capturePath('document-preview.png')});await page.locator('#media-viewer-close').click();expect(page.url()).toBe(url);await expect(page.locator('#message-text')).toHaveValue('Meu rascunho');
});
test('recorded audio is reviewed before explicit sending and cancel preserves the text draft',async({page,context})=>{
  await context.grantPermissions(['microphone']);await openChat(page);await page.locator('#message-text').fill('Texto preservado');
    const sent=[];page.on('request',req=>{if(req.url().endsWith('/api/send-voice')) sent.push(req.postDataJSON());});
    await page.locator('#record-audio').click();await expect(page.locator('#voice-status')).toContainText('Gravando');await expect.poll(()=>page.locator('#voice-status').textContent()).toMatch(/Gravando · (?!0:00)\d+:\d{2}/);await page.locator('#voice-stop').click();await expect(page.locator('#voice-preview')).toBeVisible();await page.locator('#voice-preview').evaluate(async audio=>{await audio.play();audio.pause();});expect(sent).toHaveLength(0);await page.screenshot({path:capturePath('voice-recorder.png')});
    await page.locator('#voice-cancel').click();await expect(page.locator('#attachment-info')).not.toBeVisible();await expect(page.locator('#message-text')).toHaveValue('Texto preservado');
    await page.locator('#record-audio').click();await expect.poll(()=>page.locator('#voice-status').textContent()).toMatch(/Gravando · (?!0:00)\d+:\d{2}/);await page.locator('#voice-stop').click();await expect(page.locator('#voice-preview')).toBeVisible();await page.locator('.chat-item').filter({hasText:'Alex Morgan'}).click();await expect(page.locator('#voice-recorder')).not.toBeVisible();await expect(page.locator('#attachment-info')).not.toBeVisible();
    await page.locator('#record-audio').click();await expect.poll(()=>page.locator('#voice-status').textContent()).toMatch(/Gravando · (?!0:00)\d+:\d{2}/);await page.locator('#voice-stop').click();await expect(page.locator('#voice-preview')).toBeVisible();await page.locator('#send').click();await expect.poll(()=>sent.length).toBe(1);expect(sent[0].mimeType).toMatch(/^audio\//);expect(sent[0].base64.length).toBeGreaterThan(100);expect(sent[0].caption).toBeUndefined();await expect(page.locator('#voice-recorder')).not.toBeVisible();await expect(page.locator('#message-text')).toHaveValue('Texto preservado');
    await page.locator('#record-audio').click();await expect(page.locator('#voice-status')).toContainText('Gravando');await page.locator('.chat-item').filter({hasText:'Sam Rivera'}).click();await expect(page.locator('#voice-recorder')).not.toBeVisible();await expect(page.locator('#attachment-info')).not.toBeVisible();expect(sent).toHaveLength(1);
    // Enviar fácil: o botão do próprio gravador envia depois da revisão ou para e envia direto.
    await page.locator('.chat-item').filter({hasText:'Alex Morgan'}).click();
    await page.locator('#record-audio').click();await expect(page.locator('#voice-send')).toContainText('Parar e enviar');await expect.poll(()=>page.locator('#voice-status').textContent()).toMatch(/Gravando · (?!0:00)\d+:\d{2}/);
    await page.locator('#voice-stop').click();await expect(page.locator('#voice-send')).toContainText('Enviar áudio');await expect(page.locator('#voice-send')).toBeFocused();await insideViewport(page.locator('#voice-send'));
    await page.locator('#voice-send').click();await expect.poll(()=>sent.length).toBe(2);await expect(page.locator('#voice-recorder')).not.toBeVisible();
    await page.locator('#record-audio').click();await expect.poll(()=>page.locator('#voice-status').textContent()).toMatch(/Gravando · (?!0:00)\d+:\d{2}/);
  await page.locator('#voice-view-once').click();
  await page.locator('#voice-send').click();await expect.poll(()=>sent.length).toBe(3);expect(sent[2].base64.length).toBeGreaterThan(100);expect(sent[2].viewOnce).toBe(true);await expect(page.locator('#voice-recorder')).not.toBeVisible();await expect(page.locator('#message-text')).toHaveValue('Texto preservado');
});
test('microphone denial keeps the conversation usable and spoofed PDF stays out of the viewer',async({page})=>{
  await openChat(page);await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Permission denied','NotAllowedError');};});await page.locator('#record-audio').click();await expect(page.locator('#notice')).toContainText('Permita o acesso ao microfone');await expect(page.locator('#record-audio')).toBeEnabled();await expect(page.locator('#voice-recorder')).not.toBeVisible();
  await page.route('**/api/media?**',route=>route.fulfill({json:{base64:Buffer.from('<script>window.__unsafe=true</script>').toString('base64'),mimeType:'application/pdf',fileName:'unsafe.pdf'}}));
  await page.getByRole('button',{name:'Abrir PDF',exact:true}).click();await expect(page.locator('#notice')).toContainText('Este formato não pode ser exibido');await expect(page.locator('#media-viewer')).not.toBeVisible();expect(await page.evaluate(()=>window.__unsafe)).toBeUndefined();await page.locator('#message-text').fill('Ainda posso escrever');await expect(page.locator('#message-text')).toHaveValue('Ainda posso escrever');
});
test('portfolio screenshots show only fictional data and real app surfaces',async({page})=>{
  await page.setViewportSize({width:1536,height:1024});await openChat(page);await page.screenshot({path:capturePath('workspace.png')});await page.locator('#nav-knowledge').click();await expect(page.locator('#page-knowledge')).toBeVisible();await expect(page.locator('#page-knowledge')).toContainText('Product guide.txt');await page.screenshot({path:capturePath('knowledge.png')});
});
test('trigger audio preview and footer work in a small window',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.locator('#nav-triggers').click();await page.locator('#trigger-new').click();await page.locator('#trigger-name').fill('Fora do horário');await page.locator('#trigger-type-absence').click();await page.locator('#trigger-message-audio-0').click();
  await page.locator('#trigger-media-file-0').setInputFiles({name:'sample.wav',mimeType:'audio/wav',buffer:wave()});await expect.poll(async()=>String(await page.locator('.trigger-media-preview').getAttribute('src')).startsWith('blob:')).toBe(true);await page.locator('.trigger-media-preview').evaluate(async node=>{await node.play();node.pause();});
  await insideViewport(page.locator('#trigger-save'));await page.locator('#trigger-save').click();await expect(page.locator('#trigger-editor-dialog')).not.toBeVisible();await expect(page.locator('#triggers-list')).toContainText('Fora do horário');
});
test('local AI starts from the assistant page without enabling automatic replies',async({page})=>{
  const startLocal=async()=>{const response=page.waitForResponse(value=>value.url().endsWith('/api/ai/local/start') && value.request().method()==='POST');await page.locator('#ai-local-start').click();expect((await response).status()).toBe(200);};
  await page.locator('#nav-ai').click();await expect(page.locator('#ai-local-start')).toBeVisible();await expect(page.locator('#assistant-enabled')).not.toBeChecked();
  await startLocal();await expect(page.locator('#ai-local-state')).toHaveText('Pronta para usar');await expect(page.locator('#ai-local-start')).toBeDisabled();await expect(page.locator('#assistant-enabled')).not.toBeChecked();
  await page.locator('#ai-local-cpu').check();await expect(page.locator('#ai-local-start')).toBeEnabled();await startLocal();await expect(page.locator('#ai-local-description')).toContainText('CPU');await expect(page.locator('#ai-local-cpu')).toBeChecked();await expect(page.locator('#assistant-enabled')).not.toBeChecked();
  await page.screenshot({path:capturePath('local-ai.png')});
});
test('short-message arrow menu stays visible inside the conversation',async({page})=>{
  await page.setViewportSize({width:1133,height:637});await openChat(page);const row=page.locator('.message').filter({hasText:'Maneiro'});await row.locator('.message-menu-toggle').click();const menu=row.locator('.message-menu');await expect(menu).toBeVisible();
  const region=await page.locator('#messages').boundingBox(),box=await menu.boundingBox();expect(box.x).toBeGreaterThanOrEqual(region.x+2);expect(box.y+box.height).toBeLessThanOrEqual(region.y+region.height-2);
  expect(await menu.evaluate(node=>{const r=node.getBoundingClientRect();return Boolean(document.elementFromPoint(r.left+20,r.top+20)?.closest('.message-menu'));})).toBe(true);
  await page.screenshot({path:capturePath('message-menu.png')});await page.locator('#message-text').click();await expect(menu).not.toBeVisible();
});
test('one attachment button handles files and Enter sends while Shift+Enter adds a line',async({page})=>{
  await openChat(page);await expect(page.locator('.composer-tools .attach-button')).toHaveCount(0);await expect(page.locator('#attachment-toggle')).toHaveCount(1);await page.locator('#attachment-toggle').click();await expect(page.locator('#attachment-dialog')).toBeVisible();
  const chooser=page.waitForEvent('filechooser');await page.locator('#attach-media').click();await(await chooser).setFiles(path.join(__dirname,'..','fixtures','demo.mp4'));await expect(page.locator('#attachment-info')).toContainText('demo.mp4');
  await page.locator('#message-text').fill('Vídeo de exemplo');await page.locator('#message-text').press('Enter');await expect(page.locator('#attachment-info')).not.toBeVisible();
  await page.locator('#message-text').fill('Primeira linha');await page.locator('#message-text').press('Shift+Enter');await page.locator('#message-text').pressSequentially('Segunda linha');await expect(page.locator('#message-text')).toHaveValue('Primeira linha\nSegunda linha');
});
test('video action starts playback after an explicit click',async({page})=>{
  await openChat(page);await page.getByRole('button',{name:'Reproduzir vídeo',exact:true}).click();await expect.poll(()=>page.locator('video').evaluate(node=>node.currentTime)).toBeGreaterThan(.1);await expect.poll(()=>page.locator('video').evaluate(node=>node.error?.code || null)).toBe(null);
});
test('automatic Whisper transcript appears under audio and survives page reload without duplication',async({page})=>{
  const auto=await createDemo({port:0,autoTranscription:true});
  try {await page.goto(auto.base);await openChat(page);await expect(page.locator('.transcription-text')).toHaveText('Transcrição automática de demonstração',{timeout:10000});
    await page.reload();await openChat(page);await expect(page.locator('.transcription-text')).toHaveText('Transcrição automática de demonstração');
    expect((await auto.server.transcriptions.list('5511000000000@s.whatsapp.net')).length).toBe(1);
  } finally {await auto.close();}
});
test('manual AI suggestion uses both sides even after the operator sends the latest message',async({page,demo})=>{
  await openChat(page);await page.locator('#message-text').fill('Qual data você prefere?');await page.locator('#message-text').press('Enter');await expect(page.locator('#message-text')).toHaveValue('');await expect(page.locator('#send')).toBeEnabled();await page.locator('#ai-suggest').click();await expect(page.locator('#message-text')).toHaveValue(/Studio Headphones/);
  const turns=demo.aiCalls.at(-1).messages;expect(turns.some(turn=>turn.role==='assistant' && turn.content.includes('Qual data você prefere?'))).toBe(true);expect(turns.some(turn=>turn.role==='user' && turn.content.includes('Maneiro'))).toBe(true);expect(turns[0].content).toContain('histórico recente');
});
test('reply, reactions, edits and shared location/contact use native WhatsApp operations',async({page})=>{
  await page.locator('.chat-item').filter({hasText:'Sam Rivera'}).click();await expect(page.locator('#conversation-content')).toBeVisible();
  await expect(page.locator('.message-quote')).toContainText('Olá! Posso ajudar');await expect(page.locator('.reaction-chip')).toHaveText(['👍']);
  await expect(page.locator('.location-card')).toContainText('Demo Store');await expect(page.locator('.location-card a')).toHaveAttribute('rel','noopener noreferrer');await expect(page.locator('.contact-card')).toContainText('Jamie Costa');
  const question=page.locator('.message').filter({hasText:'Qual é o prazo de entrega?'});await question.locator('.message-menu-toggle').click();await question.getByRole('button',{name:'Reagir com ❤️'}).click();await expect(question.locator('.reaction-chip')).toHaveText(['❤️']);
  await question.locator('.message-menu-toggle').click();await question.getByRole('button',{name:'Responder'}).click();await expect(page.locator('#reply-bar')).toContainText('Qual é o prazo de entrega?');
  await page.locator('#message-text').fill('Em até 3 dias');await page.locator('#message-text').press('Enter');await expect(page.locator('#message-text')).toHaveValue('');await expect(page.locator('#reply-bar')).toBeHidden();
  const mine=page.locator('.message.mine').filter({hasText:'Em até 3 dias'});await expect(mine.locator('.message-quote')).toContainText('Sam Rivera');
  await mine.locator('.message-menu-toggle').click();await mine.getByRole('button',{name:'Editar'}).click();await page.locator('#edit-text').fill('Em até 2 dias úteis');await page.locator('#edit-save').click();
  await expect(page.locator('.message.mine').filter({hasText:'Em até 2 dias úteis'}).locator('.message-meta')).toContainText('Editada');await expect(page.locator('.message.mine').filter({hasText:'Em até 2 dias úteis'}).locator('.message-quote')).toContainText('Sam Rivera');
  await page.screenshot({path:capturePath('whatsapp-features.png')});
  await page.locator('#attachment-toggle').click();await page.locator('#attach-location').click();await page.locator('#location-lat').fill('-22.9068');await page.locator('#location-lng').fill('-43.1729');await page.locator('#location-name').fill('Centro');await page.locator('#location-form button[type=submit]').click();
  await expect(page.locator('#location-dialog')).not.toBeVisible();await expect(page.locator('.location-card').filter({hasText:'Centro'})).toBeVisible();
  await page.locator('#chat-search-toggle').click();await page.locator('#chat-search').fill('quinta');await expect(page.locator('#chat-search-count')).toHaveText('1 de 1');await expect(page.locator('.message.search-hit')).toHaveCount(1);
});
test('conversation organization: pin, archive, mute and unread stay explicit',async({page})=>{
  await openChat(page);await page.locator('#show-contact').click();
  await page.locator('#chat-pin').click();await expect(page.locator('#chat-pin')).toContainText('Desafixar');await expect(page.locator('.chat-item').first()).toContainText('Alex Morgan');
  await page.locator('#chat-mute').click();await page.locator('[data-mute="-1"]').click();await expect(page.locator('#chat-mute')).toContainText('Reativar');await expect(page.locator('#contact-flags')).toContainText('Silenciada');
  await page.locator('#chat-archive').click();await expect(page.locator('#archived-row')).toBeVisible();await expect(page.locator('#archived-row-count')).toHaveText('1');await expect(page.locator('#chat-list .chat-item')).toHaveCount(9);
  await page.locator('#archived-row').click();await expect(page.locator('#chat-list .chat-item')).toHaveCount(1);await expect(page.locator('#archived-row')).toContainText('Voltar às conversas');
  await page.locator('#archived-row').click();await expect(page.locator('#chat-list .chat-item')).toHaveCount(9);
});
test('voice flow stages save separately and the voice preview never enables automatic replies',async({page})=>{
  await page.locator('#nav-voice').click();await expect(page.locator('#page-voice')).toBeVisible();await expect(page.locator('#voice-auto-transcribe')).not.toBeChecked();await expect(page.locator('#nav-voice-state')).toHaveText('—');
  await page.locator('label:has(#voice-auto-transcribe)').click();await page.locator('label:has(#voice-ai-reads)').click();await page.locator('.segmented label').filter({hasText:'Igual ao cliente'}).click();
  await page.locator('#voice-save').click();await expect(page.locator('#voice-flow-status')).toContainText('salvo');await expect(page.locator('#nav-voice-state')).toHaveText('3/3');
  await page.locator('#voice-test').click();await expect(page.locator('#voice-preview-player')).toBeVisible();await expect(page.locator('#voice-summary')).toContainText('só prepara rascunhos');
  await page.screenshot({path:capturePath('voice-flow.png')});
  await page.locator('#nav-ai').click();await expect(page.locator('#assistant-enabled')).not.toBeChecked();
  await openChatFromNav(page);await page.locator('#message-text').fill('Resposta falada');await page.locator('#speak-send').click();await expect(page.locator('#send-status')).toContainText('voz');await expect(page.locator('#message-text')).toHaveValue('');
});
async function openChatFromNav(page) {await page.locator('#nav-conversations').click();await openChat(page);}

test('"Sem resposta" queue lists unanswered conversations with the longest wait first',async({page})=>{
  await expect(page.locator('#filter-unanswered')).toBeHidden();
  await page.evaluate(async()=>{const token=document.querySelector('meta[name="whatsapp-session"]').content;for(const jid of ['5511000000004@s.whatsapp.net','5511000000002@s.whatsapp.net']) await fetch('/api/contact?jid='+encodeURIComponent(jid),{method:'PATCH',headers:{'Content-Type':'application/json','X-WhatsApp-Token':token},body:JSON.stringify({status:'pending',labels:['Sem resposta']})});});
  await page.locator('#refresh-top').click();await expect(page.locator('#filter-unanswered')).toBeVisible();await expect(page.locator('#filter-unanswered-count')).toHaveText('2');
  await page.locator('#filter-unanswered').click();await expect(page.locator('#chat-list .chat-item')).toHaveCount(2);
  await expect(page.locator('#chat-list .chat-item').first()).toContainText('Casey Silva');await expect(page.locator('#inbox-title')).toContainText('Sem resposta');
  await page.locator('#filter-all').click();await expect(page.locator('#chat-list .chat-item')).toHaveCount(10);
});
test('team tools: waiting queue, slash replies, bulk actions, transfer and dashboard',async({page})=>{
  await expect(page.locator('#filter-waiting-count')).not.toHaveText('0');await page.locator('#filter-waiting').click();
  await expect(page.locator('#inbox-title')).toContainText('Aguardando');expect(await page.locator('#chat-list .chat-item').count()).toBeGreaterThan(3);await expect(page.locator('#chat-list .wait-chip').first()).toBeVisible();
  await page.locator('#filter-all').click();await expect(page.locator('#chat-list .chat-item')).toHaveCount(10);
  await openChat(page);await page.locator('#message-text').pressSequentially('/wel');await expect(page.locator('#slash-menu')).toBeVisible();await expect(page.locator('.slash-item')).toHaveCount(1);
  await page.locator('#message-text').press('Enter');await expect(page.locator('#message-text')).toHaveValue('Olá! Obrigado pelo contato. Como posso ajudar?');await expect(page.locator('#slash-menu')).toBeHidden();await page.locator('#message-text').fill('');
  await page.locator('#show-contact').click();await page.locator('#chat-assignee').selectOption({label:'Bruno'});await expect(page.locator('#notes')).toContainText('Transferida de Ana para Bruno');await page.locator('#hide-contact').click();
  await page.locator('#bulk-toggle').click();await page.locator('.chat-item').filter({hasText:'Taylor Chen'}).click();await page.locator('.chat-item').filter({hasText:'Casey Silva'}).click();await expect(page.locator('#bulk-count')).toHaveText('2 selecionadas');
  await page.locator('[data-bulk="label"]').click();await page.locator('#bulk-label').fill('Campanha');await page.locator('#bulk-form button[type=submit]').click();await expect(page.locator('#notice')).toContainText('2 conversa(s) atualizada(s)');await expect(page.locator('#bulk-bar')).toBeHidden();
  await page.locator('#nav-team').click();await expect(page.locator('.kpi')).toHaveCount(7);await expect(page.locator('.kpi').filter({hasText:'Satisfação'})).toContainText('86%');
  await expect(page.locator('.hour-bar')).toHaveCount(10);await page.locator('.hour-hit[data-hour="10"]').hover();await expect(page.locator('#hours-tooltip')).toHaveText('10h–11h · 11 entradas');
  await page.locator('#page-team .segmented label').filter({hasText:'7 dias'}).click();await expect(page.locator('#hours-caption')).toContainText('7 dias');
  await page.locator('#page-team .segmented label').filter({hasText:'Hoje'}).click();await expect(page.locator('#hours-caption')).toContainText('Hoje');await page.mouse.move(0,0);
  await page.screenshot({path:capturePath('team-dashboard.png')});
});
test('chats archived on the phone appear under Arquivadas and every filter stays in view',async({page,demo})=>{
  await expect(page.locator('#archived-row')).toBeVisible();await expect(page.locator('#archived-row-count')).toHaveText('0');
  demo.archiveOnPhone(9);await page.locator('#refresh-top').click();
  await expect(page.locator('#archived-row')).toBeVisible();await expect(page.locator('#archived-row-count')).toHaveText('1');await expect(page.locator('#chat-list .chat-item')).toHaveCount(9);
  await page.locator('#archived-row').click();await expect(page.locator('#chat-list .chat-item')).toHaveCount(1);await expect(page.locator('#chat-list .chat-item')).toContainText('Riley Alves');
  await page.locator('#archived-row').click();
  for(const viewport of [{width:1440,height:960},{width:1133,height:637},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    for(const id of ['filter-all','filter-pending','filter-waiting','archived-row']) {const box=await page.locator('#'+id).boundingBox();expect(box,id).not.toBeNull();const panel=await page.locator('.inbox').boundingBox();expect(box.x+box.width,id+' '+viewport.width).toBeLessThanOrEqual(panel.x+panel.width+1);}
  }
});
test('chats archived on the phone before the extension are fetched from WhatsApp on request',async({page})=>{
  await page.locator('#archived-row').click();await expect(page.locator('#archived-sync')).toBeVisible();await expect(page.locator('#chat-list .chat-item')).toHaveCount(0);
  await expect(page.locator('#archived-sync-text')).toContainText('Busque as que estão arquivadas no celular');
  await page.locator('#archived-sync-button').click();await expect(page.locator('#notice')).toContainText('2 conversas arquivadas no WhatsApp.');
  await expect(page.locator('#chat-list .chat-item')).toHaveCount(2);await expect(page.locator('#chat-list')).toContainText('Avery Rocha');
  // Arquivada no WhatsApp sem conversa na Evolution: aparece com o nome da agenda e abre normalmente.
  await page.locator('#chat-list .chat-item').filter({hasText:'Morgan Blake'}).click();await expect(page.locator('#conversation-content')).toBeVisible();
  await page.locator('#archived-row').click();await expect(page.locator('#archived-sync')).toBeHidden();await expect(page.locator('#archived-row-count')).toHaveText('2');await expect(page.locator('#chat-list .chat-item')).toHaveCount(9);
});
test('the inbox search and unanswered filter keep archived chats separate',async({page,demo})=>{
  await page.evaluate(async()=>{
    const central=window.WhatsAppCentral;
    for(const name of ['Alex Morgan','Sam Rivera']) {
      const chat=central.chats().find(item=>item.name===name);
      await central.api('/contact?jid='+encodeURIComponent(chat.jid),'PATCH',{labels:['Sem resposta']});
    }
  });
  demo.archiveOnPhone(0);await page.locator('#refresh-top').click();
  await expect(page.locator('#archived-row-count')).toHaveText('1');
  const search=page.locator('#search'),alex=page.locator('#chat-list .chat-item').filter({hasText:'Alex Morgan'});
  await search.fill('Alex Morgan');await expect(alex).toHaveCount(0,{timeout:3000});
  await page.locator('#archived-row').click();await expect(alex).toHaveCount(1);
  await alex.click();await page.locator('#show-contact').click();
  await page.locator('#chat-mute').click();await page.locator('[data-mute="-1"]').click();
  await expect(page.locator('#chat-mute')).toContainText('Reativar');
  await expect(alex).toHaveCount(1);
  await search.fill('Sam Rivera');await expect(page.locator('#chat-list .chat-item')).toHaveCount(0);
  await page.locator('#nav-pending').click();
  await expect(page.locator('#archived-row')).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('#chat-list .chat-item').filter({hasText:'Sam Rivera'})).toHaveCount(1);
  await page.locator('#filter-all').click();
  await expect(page.locator('#filter-unanswered-count')).toHaveText('1');
  await page.locator('#filter-unanswered').click();
  await expect(page.locator('#chat-list .chat-item')).toHaveCount(1);
  await expect(page.locator('#chat-list .chat-item')).toContainText('Sam Rivera');
  await page.locator('#nav-overview').click();
  await expect(page.locator('#dashboard-recent')).not.toContainText('Alex Morgan');
});
test('an outdated central shows a restart notice instead of failing silently',async({page})=>{
  await page.route('**/health',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({service:'whatsapp-local',version:1})}));
  await page.reload();await expect(page.locator('#update-banner')).toContainText('versão anterior');
  await page.unroute('**/health');await page.reload();await expect(page.locator('#update-banner')).toHaveCount(0);
});
test('contacts page lists the WhatsApp address book with conversations and the right phone',async({page})=>{
  await page.locator('#nav-contacts').click();await expect(page.locator('#contacts-count')).toContainText('12 contato(s) · 10 com conversa');
  const agenda=page.locator('#contacts-body tr').filter({hasText:'Morgan Blake'});await expect(agenda).toContainText('Sem conversa');await expect(agenda).toContainText('+55 11 00000-0020');
  await expect(page.locator('#contacts-body tr').filter({hasText:'Sam Rivera'})).not.toContainText('[');
  await page.locator('#contacts-search').fill('quinn');await expect(page.locator('#contacts-body tr')).toHaveCount(1);await expect(page.locator('#contacts-count')).toContainText('1 contato(s)');
  await page.locator('#contacts-body tr').filter({hasText:'Quinn Park'}).getByRole('button',{name:'Quinn Park'}).click();await expect(page.locator('#contact-name')).toHaveText('Quinn Park');
});
