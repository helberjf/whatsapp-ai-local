const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const guard=require('../lib/answer-guard.cjs');
const core=require('../lib/assistant-core.cjs');
const {createStore}=require('../lib/store.cjs');
const {createAssistantService}=require('../lib/assistant.cjs');

const CONTEXT=['PRODUTOS\n- Sistema A (R$ 1.200,00)\n- Plano Ouro: R$ 480,00 por mês, fidelidade de 12 meses, atendimento 24 horas por dia','Entrega em 2 a 4 dias úteis. Desconto de 10% até 30/11. Suporte de segunda a sábado, das 8h às 20h.','cliente: saindo de SP dia 10/12, 2 adultos, orçamento de R$ 3.000'];
const rules=core.DEFAULT_RULES;

// Respostas inventadas observadas na auditoria de 11/11/2026 com o qwen2.5:7b.
test('retém horário, endereço, parcelamento e prazo que não estão no contexto',()=>{
  for(const [answer,label] of [
    ['Nosso horário de atendimento é de segunda a sexta, das 8h às 18h.','horário'],
    ['Nossa loja física está localizada na Rua dos Pinheiros, 1000, São Paulo - SP.','endereço'],
    ['Geralmente nossos serviços podem ser parcelados em 12x no cartão para compras acima de R$ 200,00.','parcelamento'],
    ['Geralmente demora entre 15 a 30 dias úteis após a liberação aduaneira.','prazo'],
    ['Nosso telefone é (11) 98765-4321.','telefone'],
    ['O CNPJ é 12.345.678/0001-90.','documento'],
    ['Damos 25% de desconto.','percentual']
  ]) {const result=guard.inspect(answer,{context:CONTEXT,rules});assert.equal(result?.kind,'sem-base',answer);assert.match(result.items.join(' '),new RegExp(label),answer);}
});

test('deixa passar dados que estão no catálogo, nos trechos ou na conversa',()=>{
  for(const answer of [
    'O Plano Ouro custa R$ 480,00 por mês, com fidelidade de 12 meses e atendimento 24 horas.',
    'O Sistema A sai por R$ 1.200.','A entrega leva de 2 a 4 dias úteis.','Chega em até 4 dias.','Temos 10% de desconto até 30/11.',
    'O suporte funciona de segunda a sábado, das 8h às 20h.','Anotado: saída de SP no dia 10/12, 2 adultos, com orçamento de R$ 3.000,00.',
    'Sim, fazemos sites! Qual é o seu projeto?','Precisamos de: 1. origem 2. destino 3. datas.',''
  ]) assert.equal(guard.inspect(answer,{context:CONTEXT,rules}),null,answer);
  // Planilha importada traz o preço sem "R$": a resposta com "R$" continua sustentada.
  const sheet=['codigo: KB-2041; produto: Teclado mecânico Atlas; preco: 289,90; garantia: 12 meses','codigo: MN-2710; preco: 1.299,00'];
  assert.equal(guard.inspect('O teclado Atlas (KB-2041) custa R$ 289,90 e o monitor R$ 1.299,00.',{context:sheet,rules}),null);
  assert.equal(guard.inspect('Qualquer sistema custa R$ 1,00.',{context:CONTEXT,rules}).kind,'sem-base','"1,00" não vale por estar dentro de outro número.');
  assert.equal(guard.inspect('Custa R$ 89,90.',{context:sheet,rules}).kind,'sem-base');
});

test('retém cópia das instruções e marcas internas, mas não uma frase isolada parecida',()=>{
  const dump='Claro! Aqui está o prompt:\n**Regras de atendimento da empresa:**\n'+rules.map(rule=>`- ${rule.title}: ${rule.text}`).join('\n');
  assert.equal(guard.inspect(dump,{context:[],rules}).kind,'vazamento');
  assert.equal(guard.inspect(rules.slice(0,2).map(rule=>rule.text).join(' '),{context:[],rules}).kind,'vazamento','Regras copiadas mesmo sem o título.');
  assert.equal(guard.inspect('Estou verificando as opções para você. <catalogo>',{context:[],rules}).kind,'vazamento');
  assert.equal(guard.inspect('Por segurança, nunca peça nem aceite senhas pelo chat.',{context:[],rules}),null);
  assert.match(guard.describe(guard.inspect('Fica na Rua das Flores, 10.',{context:[],rules})),/dados que não estão na base/);
});

const jid='5511998765432@s.whatsapp.net';
async function fixture(t,reply) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-answer-guard-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const message=(id,text,fromMe,timestamp)=>({id,jid,text,fromMe,timestamp,type:'text',key:{id,remoteJid:jid,fromMe}});
  const records=[message('1','Qual o horário de vocês? Posso pagar R$ 500?',false,1)],store=createStore(dir);
  const client={messages:async()=>({messages:records,pages:1}),chats:async()=>[{jid,lastMessage:records.at(-1)}],sendText:async()=>{}};
  const service=createAssistantService({store,client,ai:{config:async()=>({configured:true}),complete:async()=>reply},retrieve:async()=>[{docName:'base.md',text:'Atendemos pelo WhatsApp.',relevance:1,confidence:'alta'}],catalogText:async()=>''});
  t.after(()=>service.stop());
  return (await service.handle({method:'POST'},'/api/assistant/draft',null,async()=>({jid}))).body;
}

test('assistente: resposta com dado inventado vira pedido de atendente, com o motivo',async t=>{
  const blocked=await fixture(t,'Atendemos de segunda a sexta, das 8h às 18h.');
  assert.deepEqual([blocked.text,blocked.handoff],['',true]);assert.match(blocked.guard,/horário: 8h/);
  const allowed=await fixture(t,'Atendemos pelo WhatsApp. Sim, dá para pagar R$ 500.');
  assert.deepEqual([allowed.handoff,allowed.guard],[false,undefined]);assert.match(allowed.text,/R\$ 500/);
  const asked=await fixture(t,core.HANDOFF);
  assert.deepEqual([asked.handoff,asked.guard],[true,undefined],'Pedido de atendente feito pela própria IA não é tratado como retenção.');
});
