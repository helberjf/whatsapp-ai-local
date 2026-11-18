// Sugestão da IA no editor: cada clique troca por uma resposta nova; e a IA ligada em "só rascunho" nunca envia.
const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});

async function openChat(page,demo) {
  await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item').first()).toBeVisible();
  await page.locator('#chat-list .chat-item').first().click();await expect(page.locator('#message-text')).toBeVisible();
}

test('Sugerir com IA deixa a resposta no editor e Nova sugestão troca por outra, sem enviar',async({page,demo})=>{
  await openChat(page,demo);
  const editor=page.locator('#message-text'),button=page.locator('#ai-suggest'),sentBefore=await page.locator('#messages .message.out, #messages .out').count();
  await expect(button).toHaveText('Sugerir com IA');
  await button.click();
  await expect(editor).toHaveValue('Posso ajudar com o produto Studio Headphones. Quer que eu confirme o prazo de entrega?');
  await expect(button).toHaveText('Nova sugestão');
  await button.click();
  await expect(editor).toHaveValue('Oi! Os Studio Headphones são sem fio e bem confortáveis. Quer saber mais sobre eles?');
  const asked=demo.aiCalls.at(-1).messages.at(-1).content;
  expect(asked).toContain('já foram descartadas:\n1. Posso ajudar com o produto Studio Headphones.');
  expect(demo.aiCalls.at(-1).options.temperature).toBe(.8);
  await button.click();
  await expect(editor).toHaveValue('Claro! Me conta como você pretende usar os fones que eu te ajudo a escolher.');
  expect(demo.aiCalls.at(-1).messages.at(-1).content).toMatch(/1\. Posso ajudar[\s\S]*2\. Oi! Os Studio Headphones/);
  // Editou a sugestão: o botão volta a "Sugerir com IA" e trocar o texto pede confirmação.
  await editor.fill('Meu texto escrito à mão');await expect(button).toHaveText('Sugerir com IA');
  page.once('dialog',dialog=>dialog.dismiss());await button.click();
  await expect(editor).toHaveValue('Meu texto escrito à mão');
  expect(await page.locator('#messages .message.out, #messages .out').count()).toBe(sentBefore);
});

test('IA ligada em só rascunho: público e modo ficam salvos e o aviso diz que nada é enviado',async({page,demo})=>{
  await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item').first()).toBeVisible();
  await page.locator('#nav-ai').click();
  await page.locator('#assistant-audience').selectOption('all');
  await page.locator('#assistant-default-mode').selectOption('draft');
  await expect(page.locator('#assistant-default-mode-hint')).toContainText('não envia nada');
  await page.getByRole('button',{name:'Salvar público e modo'}).click();
  await expect(page.locator('#assistant-audience-status')).toContainText('Público salvo');
  const dialogs=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.accept();});
  await page.locator('#assistant-enabled').check();
  await expect(page.locator('#assistant-status')).toContainText('ligadas');
  expect(dialogs[0]).toContain('Nada é enviado sem você');
  await expect(page.locator('#assistant-summary')).toContainText('só rascunho, nada é enviado sozinho');
  await page.reload();await page.locator('#nav-ai').click();
  await expect(page.locator('#assistant-audience')).toHaveValue('all');
  await expect(page.locator('#assistant-default-mode')).toHaveValue('draft');
  await expect(page.locator('#assistant-enabled')).toBeChecked();
});
