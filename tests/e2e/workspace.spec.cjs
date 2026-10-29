const {test:base,expect}=require('@playwright/test');
const path=require('node:path');
const {createDemo,wave}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});
const screenshotDir=path.join(__dirname,'..','..','docs','screenshots');
async function openChat(page) {await page.locator('.chat-item').filter({hasText:'Alex Morgan'}).click();await expect(page.locator('#conversation-content')).toBeVisible();}
async function insideViewport(locator) {await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();expect(box).not.toBeNull();const viewport=locator.page().viewportSize();expect(box.x).toBeGreaterThanOrEqual(-1);expect(box.y).toBeGreaterThanOrEqual(-1);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width+1);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height+1);}
test.beforeEach(async({page,demo})=>{const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item'),()=>JSON.stringify(errors)).toHaveCount(10);expect(errors).toEqual([]);});

for(const viewport of [{width:1440,height:960},{width:1133,height:637},{width:390,height:844}]) {
  test(`navigation and composer remain reachable at ${viewport.width}x${viewport.height}`,async({page})=>{
    await page.setViewportSize(viewport);
    for(const locator of await page.locator('.main-nav button').all()) await insideViewport(locator);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await openChat(page);for(const id of ['message-text','emoji-toggle','send']) await insideViewport(page.locator('#'+id));
    await page.locator('#emoji-toggle').click();await expect(page.locator('#emoji-dialog')).toBeVisible();await page.getByRole('button',{name:'Feliz',exact:true}).click();await expect(page.locator('#message-text')).toHaveValue('😊');
    await page.locator('#show-contact').click();await expect(page.locator('#contact-info-open')).toBeVisible();await insideViewport(page.locator('#contact-info-open'));
  });
}
test('media players, safe links and draft survive polling',async({page})=>{
  await page.setViewportSize({width:1536,height:1100});
  await openChat(page);await page.locator('#message-text').fill('Rascunho preservado');
  await expect(page.locator('.message-link')).toHaveCount(2);await expect(page.locator('.message-link').first()).toHaveAttribute('rel','noopener noreferrer');
  await page.locator('.audio-load').click();await expect(page.locator('audio')).toHaveAttribute('src',/^blob:/);await page.locator('audio').evaluate(async node=>{await node.play();node.pause();node.currentTime=1;});
  await page.locator('.audio-speed').selectOption('1.5');expect(await page.locator('audio').evaluate(node=>node.playbackRate)).toBe(1.5);
  await page.locator('.video-load').click();await expect(page.locator('video')).toHaveAttribute('src',/^blob:/);await page.locator('video').evaluate(async node=>{await node.play();node.pause();node.currentTime=1;});
  await page.locator('#refresh-top').click();await expect.poll(()=>page.locator('video').evaluate(node=>node.currentTime)).toBeGreaterThan(.8);await expect(page.locator('#message-text')).toHaveValue('Rascunho preservado');
  await page.screenshot({path:path.join(screenshotDir,'media.png')});
});
test('trigger editor saves against the real service and remains disabled until opted in',async({page})=>{
  await page.locator('#nav-triggers').click();await expect(page.locator('#triggers-dialog')).toBeVisible();await page.locator('#trigger-new').click();
  await page.locator('#trigger-name').fill('Boas-vindas');await page.locator('.trigger-message-text').first().fill('Olá, {nome}! Obrigado pelo contato.');
  await insideViewport(page.locator('#trigger-save'));await page.screenshot({path:path.join(screenshotDir,'triggers.png')});await page.locator('#trigger-save').click();
  await expect(page.locator('#trigger-editor-dialog')).not.toBeVisible();await expect(page.locator('#triggers-list')).toContainText('Boas-vindas');await expect(page.locator('#triggers-enabled')).not.toBeChecked();
});
test('contact details, disappearing options and deletion are explicit',async({page})=>{
  await openChat(page);await page.locator('#contact-info-open').click();await expect(page.locator('#contact-info-data')).toContainText('Alex Morgan');await page.getByRole('button',{name:'Fechar dados do contato'}).click();
  await page.locator('#disappearing-open').click();await expect(page.locator('#disappearing-save')).toBeEnabled();await page.locator('#disappearing-expiration').selectOption('86400');await page.locator('#disappearing-save').click();await expect(page.locator('#disappearing-dialog')).not.toBeVisible();
  const own=page.locator('.message.mine').filter({hasText:'Conheça o catálogo'});await own.locator('.message-menu-toggle').click();await own.getByRole('button',{name:'Apagar para todos'}).click();await expect(page.locator('#delete-dialog')).toBeVisible();await expect(own).toContainText('Conheça o catálogo');await page.locator('#delete-confirm').click();await expect(page.locator('.message-deleted')).toContainText('Mensagem apagada');
});
test('portfolio screenshots show only fictional data and real app surfaces',async({page})=>{
  await page.setViewportSize({width:1536,height:1024});await openChat(page);await page.screenshot({path:path.join(screenshotDir,'workspace.png')});await page.locator('#nav-knowledge').click();await expect(page.locator('#page-knowledge')).toBeVisible();await expect(page.locator('#page-knowledge')).toContainText('Product guide.txt');await page.screenshot({path:path.join(screenshotDir,'knowledge.png')});
});
test('trigger audio preview and footer work in a small window',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.locator('#nav-triggers').click();await page.locator('#trigger-new').click();await page.locator('#trigger-name').fill('Fora do horário');await page.locator('#trigger-type-absence').click();await page.locator('#trigger-message-audio-0').click();
  await page.locator('#trigger-media-file-0').setInputFiles({name:'sample.wav',mimeType:'audio/wav',buffer:wave()});await expect.poll(async()=>String(await page.locator('.trigger-media-preview').getAttribute('src')).startsWith('blob:')).toBe(true);await page.locator('.trigger-media-preview').evaluate(async node=>{await node.play();node.pause();});
  await insideViewport(page.locator('#trigger-save'));await page.locator('#trigger-save').click();await expect(page.locator('#trigger-editor-dialog')).not.toBeVisible();await expect(page.locator('#triggers-list')).toContainText('Fora do horário');
});
