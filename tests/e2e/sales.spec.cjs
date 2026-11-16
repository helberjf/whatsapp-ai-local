// Vendas com IA (qualificação, agenda, Pix e contrato) e áudio de boas-vindas como mensagem de voz, na demo.
const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});

async function openSales(page,demo) {
  await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item').first()).toBeVisible();
  await page.getByRole('button',{name:'Vendas com IA'}).click();
  await expect(page.getByRole('heading',{name:'Vendas com IA'})).toBeVisible();
  await expect(page.locator('#sales-status')).toHaveText('');
}
async function fillPix(page) {
  await page.getByLabel('Tipo da chave').selectOption('email');
  await page.getByLabel('Chave Pix').fill('Vendas@Exemplo.com');
  await page.getByLabel('Nome do recebedor').fill('Loja Exemplo');
  await page.getByRole('textbox',{name:'Cidade'}).fill('São Paulo');
}

test('tudo começa desligado; ligar o Pix sem chave é recusado',async({page,demo})=>{
  await openSales(page,demo);
  for(const name of ['Qualificar leads e atualizar o CRM automaticamente','Deixar a IA agendar','Deixar a IA enviar o Pix','Deixar a IA enviar o contrato']) await expect(page.getByLabel(name)).not.toBeChecked();
  await expect(page.locator('#nav-sales-state')).toHaveText('—');
  await expect(page.locator('#sales-next-slots')).toContainText('Ligue a agenda');
  await page.getByLabel('Deixar a IA enviar o Pix').check();
  await page.getByRole('button',{name:'Salvar vendas com IA'}).click();
  await expect(page.locator('#sales-status')).toHaveText('Para ligar o Pix, preencha a chave, o nome do recebedor e a cidade (como estão no banco).');
  await page.getByLabel('Deixar a IA enviar o Pix').uncheck();
  await page.getByLabel('Deixar a IA enviar o contrato').check();
  await page.getByRole('button',{name:'Salvar vendas com IA'}).click();
  await expect(page.locator('#sales-status')).toHaveText('Para ligar o contrato, anexe o arquivo ou informe o link de assinatura.');
});

test('qualificação, agenda, Pix e contrato ficam salvos e o código de teste é um Pix válido',async({page,demo})=>{
  await openSales(page,demo);
  await page.getByLabel('Qualificar leads e atualizar o CRM automaticamente').check();
  await page.getByLabel('Deixar a IA agendar').check();
  await page.getByLabel('O que será agendado').fill('uma reunião de apresentação');
  await page.getByLabel('Duração').selectOption('60');
  // Lembrete: 1 hora antes já vem marcado; aqui também 1 dia antes.
  await expect(page.getByLabel('1 hora antes')).toBeChecked();await expect(page.getByLabel('1 dia antes')).not.toBeChecked();
  await page.getByLabel('1 dia antes').check();
  await page.getByLabel('Instruções enviadas na confirmação (opcional)').fill('A reunião será por vídeo.');
  await page.getByLabel('Deixar a IA enviar o Pix').check();
  await fillPix(page);
  await page.getByLabel('Deixar a IA enviar o contrato').check();
  await page.getByLabel('Link de assinatura (opcional)').fill('https://assinatura.example/doc/1');
  await page.locator('#sales-contract-file').setInputFiles({name:'contrato.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 contrato de teste')});
  await expect(page.locator('#sales-contract-current')).toContainText('contrato.pdf');
  await page.getByLabel('Valor para testar ou enviar agora (opcional)').fill('199,90');
  await page.getByRole('button',{name:'Salvar e gerar código de teste'}).click();
  await expect(page.locator('#sales-status')).toContainText('Código de teste gerado');
  await expect(page.getByLabel('Código Pix de teste')).toHaveValue(/^00020126400014br\.gov\.bcb\.pix0118vendas@exemplo\.com5204000053039865406199\.905802BR5912LOJA EXEMPLO6009SAO PAULO62090505TESTE6304[0-9A-F]{4}$/);
  await expect(page.locator('#nav-sales-state')).toHaveText('4/4');
  await expect(page.locator('#sales-next-slots')).toContainText('Próximos horários livres:');
  await page.reload();await page.getByRole('button',{name:'Vendas com IA'}).click();
  await expect(page.getByLabel('Deixar a IA agendar')).toBeChecked();
  await expect(page.getByLabel('O que será agendado')).toHaveValue('uma reunião de apresentação');
  await expect(page.getByLabel('Duração')).toHaveValue('60');
  await expect(page.getByLabel('1 dia antes')).toBeChecked();await expect(page.getByLabel('1 hora antes')).toBeChecked();await expect(page.getByLabel('15 minutos antes')).not.toBeChecked();
  await expect(page.getByLabel('Chave Pix')).toHaveValue('vendas@exemplo.com');
  await expect(page.getByLabel('Deixar a IA enviar o contrato')).toBeChecked();
  await expect(page.locator('#sales-contract-current')).toContainText('contrato.pdf');
  await expect(page.locator('#sales-appointments')).toContainText('Nenhum compromisso marcado.');
});

test('atendente envia o Pix para a conversa aberta, com confirmação',async({page,demo})=>{
  await openSales(page,demo);
  await page.getByRole('button',{name:'Enviar para a conversa aberta'}).first().click();
  await expect(page.locator('#sales-status')).toHaveText('Abra antes a conversa que vai receber o envio.');
  await fillPix(page);
  await page.getByRole('button',{name:'Salvar vendas com IA'}).click();
  await expect(page.locator('#sales-status')).toContainText('Vendas com IA salvas');
  await page.locator('#nav-conversations').click();
  await page.locator('#chat-list .chat-item').first().click();
  await expect(page.locator('#message-text')).toBeVisible();
  await page.getByRole('button',{name:'Vendas com IA'}).click();
  await page.getByLabel('Valor para testar ou enviar agora (opcional)').fill('75,50');
  const dialogs=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.accept();});
  await page.locator('#sales-pix-send').click();
  await expect(page.locator('#sales-status')).toContainText('Código Pix enviado para');
  expect(dialogs[0]).toContain('Enviar o código Pix de R$ 75,50 para');
  await expect(page.locator('#sales-log')).toContainText('Pix de R$ 75,50 enviado pelo atendente');
  await page.locator('#nav-conversations').click();
  await expect(page.locator('#messages')).toContainText('Pix de R$ 75,50 para Loja Exemplo.');
  await expect(page.locator('#messages')).toContainText('540575.505802BR5912LOJA EXEMPLO');
});

test('áudio do gatilho de primeiro contato é salvo como mensagem de voz gravada na hora',async({page,demo})=>{
  await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item').first()).toBeVisible();
  await page.getByRole('button',{name:'Gatilhos'}).click();
  await page.getByRole('button',{name:'+ Novo gatilho'}).click();
  await page.getByLabel('Nome do gatilho').fill('Áudio de boas-vindas');
  await page.locator('#trigger-message-audio-0').click();
  const voice=page.getByLabel('Enviar como mensagem de voz gravada na hora');
  await expect(voice).toBeChecked();
  await page.locator('#trigger-media-file-0').setInputFiles({name:'boas-vindas.ogg',mimeType:'audio/ogg',buffer:Buffer.from('OggS audio de teste')});
  await expect(page.locator('.trigger-file-name')).toHaveText('boas-vindas.ogg');
  const saved=page.waitForResponse(response=>response.url().endsWith('/api/triggers') && response.request().method()==='PUT');
  await page.getByRole('button',{name:'Salvar gatilho'}).click();
  const message=(await (await saved).json()).rules.at(-1).messages[0];
  expect(message.type).toBe('audio');expect(message.voice).toBe(true);
  await expect(page.locator('#triggers-list')).toContainText('Mensagem de voz: boas-vindas.ogg');
  // Desligada, a opção volta a enviar o áudio como arquivo anexado.
  await page.locator('#triggers-list .trigger-rule').last().getByRole('button',{name:'Editar'}).click();
  await expect(voice).toBeChecked();await voice.uncheck({force:true});
  const again=page.waitForResponse(response=>response.url().endsWith('/api/triggers') && response.request().method()==='PUT');
  await page.getByRole('button',{name:'Salvar gatilho'}).click();
  expect((await (await again).json()).rules.at(-1).messages[0].voice).toBeUndefined();
  await expect(page.locator('#triggers-list')).toContainText('Áudio: boas-vindas.ogg');
});
