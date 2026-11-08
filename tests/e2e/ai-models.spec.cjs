const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});
async function openAi(page,demo) {await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item')).toHaveCount(10);await page.locator('#nav-ai').click();await expect(page.locator('#ai-provider')).toBeVisible();await expect(page.locator('#ai-provider option')).toHaveCount(12);}
test('seleciona modelos, limpa chave ao trocar provedor e mantém modelo manual após salvar',async({page,demo})=>{
  await openAi(page,demo);
  await expect(page.locator('#ai-provider option')).toHaveCount(12);await expect(page.locator('#ai-model-select')).toHaveValue('demo-local');
  await page.locator('#ai-provider').selectOption('openai');await expect(page.locator('#ai-model-select')).toHaveValue('gpt-4.1-mini');
  await expect(page.locator('#ai-key-hint')).toContainText('criptografada');await page.locator('#ai-key').fill('sk-FAKE-PRIVATE');
  await page.locator('#ai-base').fill('https://example.test/v1');await page.locator('#ai-provider').selectOption('gemini');await expect(page.locator('#ai-key')).toHaveValue('');await expect(page.locator('#ai-base')).toHaveValue('');await expect(page.locator('#ai-model-select')).toHaveValue('gemini-3.8-flash');
  await page.locator('#ai-provider').selectOption('custom');await page.locator('#ai-base').fill('http://localhost:1234/v1');await page.locator('#ai-model-select').selectOption('__custom__');await page.locator('#ai-model').fill('meu-modelo-privado');
  expect(await page.locator('#ai-form').evaluate(form=>[...form.elements].filter(item=>item.willValidate&&!item.validity.valid).map(item=>item.id))).toEqual([]);
  const saved=page.waitForResponse(response=>response.url().endsWith('/api/ai') && response.request().method()==='PUT');await page.locator('#ai-save').click();expect((await saved).status()).toBe(200);await expect(page.locator('#ai-status')).toHaveText('Configuração salva.');
  await openAi(page,demo);await expect(page.locator('#ai-model')).toHaveValue('meu-modelo-privado');await expect(page.locator('#ai-model-select')).toHaveValue('meu-modelo-privado');
});
test('carregar modelos envia chave no corpo, seleciona catálogo e preserva sugestões em erro',async({page,demo})=>{
  const calls=[];let fail=false;
  await page.route('**/api/ai/models',async route=>{calls.push(route.request());await route.fulfill({status:fail?502:200,contentType:'application/json',body:JSON.stringify(fail?{error:'Provedor indisponível'}:{provider:'groq',models:[{id:'modelo-da-conta',label:'Modelo da conta'}]})});});
  await openAi(page,demo);await page.locator('#ai-provider').selectOption('groq');await page.locator('#ai-key').fill('gsk-FAKE-PRIVATE');await page.locator('#ai-models-load').click();
  await expect(page.locator('#ai-models-status')).toContainText('1 modelo');await expect(page.locator('#ai-model-select')).toHaveValue('modelo-da-conta');expect(calls[0].postDataJSON().apiKey).toBe('gsk-FAKE-PRIVATE');expect(calls[0].url()).not.toContain('PRIVATE');
  await page.locator('#ai-save').click();await expect(page.locator('#ai-status')).toContainText('criptografada');await expect(page.locator('#ai-key')).toHaveValue('');
  fail=true;await page.locator('#ai-models-load').click();await expect(page.locator('#ai-models-status')).toContainText('Provedor indisponível');await expect(page.locator('#ai-model-select')).toHaveValue('modelo-da-conta');
  await page.locator('#ai-provider').selectOption('openai');await expect(page.locator('#ai-clear')).toBeHidden();await page.locator('#ai-provider').selectOption('groq');await expect(page.locator('#ai-clear')).toBeVisible();await expect(page.locator('#ai-key-hint')).toContainText('Groq');
  await page.locator('#ai-provider').selectOption('openai');await page.locator('#ai-save').click();await expect(page.locator('#ai-status')).toContainText('Configuração salva');await openAi(page,demo);await page.locator('#ai-provider').selectOption('groq');await expect(page.locator('#ai-model')).toHaveValue('');page.once('dialog',dialog=>dialog.accept());await page.locator('#ai-clear').click();await expect(page.locator('#ai-status')).toHaveText('Chave removida.');await expect(page.locator('#ai-clear')).toBeHidden();
});
test('resposta de catálogo atrasada não modifica outro provedor e formulário cabe no celular',async({page,demo})=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/ai/models',async route=>{await pending;await route.fulfill({contentType:'application/json',body:JSON.stringify({provider:'openai',models:[{id:'gpt-old',label:'Old model'}]})});});
  await page.setViewportSize({width:390,height:844});await openAi(page,demo);await page.locator('#ai-provider').selectOption('openai');await page.locator('#ai-key').fill('sk-FAKE-PRIVATE');
  const request=page.waitForRequest('**/api/ai/models');await page.locator('#ai-models-load').click();await request;await page.locator('#ai-provider').selectOption('gemini');release();await expect(page.locator('#ai-model-select')).toHaveValue('gemini-3.8-flash');
  await expect(page.locator('#ai-models-load')).toBeEnabled();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:test.info().outputPath('ai-models-mobile.png'),fullPage:true});
});
