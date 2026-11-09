// Aviso de IA local fora do ar: a rota de saúde é simulada, sem derrubar nem iniciar o Ollama de verdade.
const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});

test('queda do Ollama aparece na faixa e no indicador, e a volta é avisada',async({page,demo})=>{
  let health={watching:true,running:false,since:'2026-11-08T03:17:00.000Z',restarts:0,lastError:'O Ollama foi iniciado, mas não respondeu a tempo.',nextAttemptAt:'2026-11-08T03:19:00.000Z',search:{mode:'lexical'}};
  await page.route('**/api/ai/health',route=>route.fulfill({json:health}));
  await page.clock.install();
  await page.goto(demo.base);
  const banner=page.getByRole('alert').filter({hasText:'IA local'});
  await expect(banner).toContainText('fora do ar desde 00:17');
  await expect(banner).toContainText('próxima tentativa às 00:19');
  await expect(banner).toContainText('não respondeu a tempo');
  await expect(banner).toContainText('só palavras-chave');
  await expect(page.locator('#status-ai')).toHaveText('Fora do ar');
  await expect(page.locator('#dot-ai')).toHaveClass(/alert/);
  // O vigia do servidor religou: na próxima consulta (a cada 30 s) a faixa some e a volta é avisada.
  health={...health,running:true,since:'2026-11-08T03:19:02.000Z',restarts:1,lastError:'',nextAttemptAt:null,search:{mode:'hybrid'}};
  await page.clock.runFor(35_000);
  await expect(banner).toBeHidden();
  await expect(page.locator('#notice')).toHaveText('IA local religada. A busca por significado voltou.');
  await expect(page.locator('#status-ai')).not.toHaveText('Fora do ar');
  await expect(page.locator('#dot-ai')).not.toHaveClass(/alert/);
});

test('sem depender do Ollama, nenhuma faixa aparece',async({page,demo})=>{
  await page.route('**/api/ai/health',route=>route.fulfill({json:{watching:false,running:null,since:null,restarts:0,lastError:'',nextAttemptAt:null,search:{mode:'hybrid'}}}));
  await page.goto(demo.base);
  await expect(page.locator('#chat-list .chat-item').first()).toBeVisible();
  await expect(page.locator('#ai-health-banner')).toBeHidden();
  await expect(page.locator('#status-ai')).not.toHaveText('Fora do ar');
});

test('central sem resposta mostra o que fazer em vez de "Failed to fetch"',async({page,demo})=>{
  await page.goto(demo.base);await expect(page.locator('#chat-list .chat-item').first()).toBeVisible();
  await page.route('**/api/kb',route=>route.abort('connectionrefused'));
  await page.getByRole('button',{name:/Base de Conhecimento/}).click();
  await expect(page.locator('#notice')).toHaveText('A central não está respondendo. Se ela foi fechada, abra "Iniciar WhatsApp Central" e recarregue a página.');
});
