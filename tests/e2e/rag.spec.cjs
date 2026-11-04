// RAG no navegador: busca por significado, confiabilidade e sugestões do robô.
// Os passos seguem o estilo do `npm run codegen` (getByRole/getByLabel), sobre a demo com embeddings fictícios.
const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});

async function openKnowledge(page) {
  await page.getByRole('button',{name:/Base de Conhecimento/}).click();
  await expect(page.locator('#kb-search')).toContainText('palavras-chave e por significado (demo-embed): 1 de 1');
}
async function ask(page,question) {
  const knowledge=page.locator('#page-knowledge');
  await knowledge.getByLabel('Pergunta').fill(question);
  await knowledge.getByRole('button',{name:'Perguntar'}).click();
  await expect(knowledge.locator('#kb-answer')).not.toContainText('Consultando a base');
  return knowledge.locator('#kb-answer');
}

test.beforeEach(async({page,demo})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item')).toHaveCount(10);expect(errors).toEqual([]);
});

test('pergunta sem palavras em comum encontra o trecho por significado',async({page})=>{
  await openKnowledge(page);
  const answer=await ask(page,'fone sem fio');
  await expect(answer).toContainText('Confiança da busca: alta · modo equilibrado');
  await expect(answer.getByText(/Product guide\.txt · \d+% relevante · por significado · confiança alta/)).toBeVisible();
  await answer.getByText(/Product guide\.txt/).click();
  await expect(answer).toContainText('Studio Headphones');
});

test('assunto fora da base não traz trecho nenhum',async({page})=>{
  await openKnowledge(page);
  const answer=await ask(page,'receita de bolo de cenoura');
  await expect(answer).toContainText('Confiança da busca: nenhum trecho confiável');
  await expect(answer).toContainText('Nenhum trecho da base foi usado.');
});

test('confiabilidade rigorosa descarta trecho de confiança média e fica salva',async({page})=>{
  await openKnowledge(page);
  const reliability=page.getByLabel('Confiabilidade das respostas');
  await expect(reliability).toHaveValue('balanced');
  await reliability.selectOption('strict');
  await expect(page.locator('#kb-reliability-hint')).toContainText('só usa trechos de confiança alta');
  await expect(page.locator('#notice')).toHaveText('Confiabilidade salva.');
  let answer=await ask(page,'Studio');
  await expect(answer).toContainText('Nenhum trecho da base foi usado.');
  await expect(answer).toContainText('modo rigoroso');
  await page.reload();await openKnowledge(page);
  await expect(page.getByLabel('Confiabilidade das respostas')).toHaveValue('strict');
  await page.getByLabel('Confiabilidade das respostas').selectOption('balanced');
  answer=await ask(page,'Studio');
  await expect(answer.getByText(/Product guide\.txt · \d+% relevante · confiança média/)).toBeVisible();
});

test('robô sugere perguntas e respostas pela IA e só adiciona regra desligada, sem salvar',async({page})=>{
  await page.getByRole('button',{name:'Automações'}).click();
  const robot=page.getByRole('dialog',{name:'Automações'});
  await robot.getByRole('button',{name:'Gerar sugestões com IA'}).click();
  await expect(robot.locator('#automation-suggest-status')).toHaveText('2 sugestões prontas. Adicione as que fizerem sentido para o seu negócio.');
  const warranty=robot.locator('.automation-suggestion').filter({hasText:'O fone tem garantia?'});
  await expect(warranty).toContainText('Palavras: garantia, defeito');
  await expect(warranty).toContainText('Fonte: Product guide.txt · confiança alta');
  await expect(robot.locator('.automation-suggestion').filter({hasText:'Qual é o prazo de entrega?'})).toContainText('Sem trecho correspondente na base');
  await warranty.getByRole('button',{name:'Adicionar como regra'}).click();
  await expect(warranty.getByRole('button',{name:'Adicionada às regras'})).toBeDisabled();
  const rule=robot.locator('.automation-rule').last();
  await expect(rule.getByRole('textbox',{name:'Nome'})).toHaveValue('O fone tem garantia?');
  await expect(rule.getByRole('textbox',{name:/Palavras ou frases/})).toHaveValue('garantia, defeito');
  await expect(rule.getByRole('checkbox',{name:'Regra ativa'})).not.toBeChecked();
  // Sem clicar em Salvar regras, nada chega ao servidor: reabrir recarrega as regras salvas.
  await robot.getByRole('button',{name:'Fechar Automações'}).click();
  await page.getByRole('button',{name:'Automações'}).click();
  await expect(robot.locator('.automation-rule').filter({has:page.locator('input[value="O fone tem garantia?"]')})).toHaveCount(0);
});
