// Jeito de responder da IA: só a conversa, quantas mensagens ler e tom natural, salvos e mantidos após recarregar.
const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});

test('escolhe responder só pela conversa, com tom natural, e a escolha fica salva',async({page,demo})=>{
  await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item').first()).toBeVisible();
  await page.locator('#nav-ai').click();
  const source=page.getByLabel('De onde a IA tira as respostas?'),tone=page.getByLabel('Tom das respostas'),history=page.getByLabel('Mensagens recentes que a IA lê');
  await expect(source).toHaveValue('base');await expect(tone).toHaveValue('formal');await expect(history).toHaveValue('14');
  await source.selectOption('conversation');await tone.selectOption('natural');await history.fill('6');
  await expect(page.locator('#assistant-style-hint')).toContainText('sem consultar a base');
  await expect(page.locator('#assistant-style-hint')).toContainText('sem “Prezado”');
  await page.getByRole('button',{name:'Salvar jeito de responder'}).click();
  await expect(page.locator('#assistant-style-status')).toHaveText('Salvo. Vale para as próximas respostas e sugestões.');
  await page.reload();await page.locator('#nav-ai').click();
  await expect(source).toHaveValue('conversation');await expect(tone).toHaveValue('natural');await expect(history).toHaveValue('6');
  await history.fill('50');await page.getByRole('button',{name:'Salvar jeito de responder'}).click();
  await expect(page.locator('#assistant-style-status')).toHaveText('A IA pode ler de 2 a 30 mensagens recentes.');
});
