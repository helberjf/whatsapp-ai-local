# RAG da base de conhecimento

Como a central recupera trechos da base, monta o contexto e gera respostas; o que foi medido nas avaliações de 11/11 e 16/11/2026; e como repetir a avaliação.

**Situação:** a recuperação é adequada, com ressalvas. As respostas geradas pelo modelo local (`qwen2.5:7b`) ainda **não são confiáveis para envio automático sem revisão**: mesmo depois das correções de 11/11 e 16/11, o modelo ainda acrescenta afirmações sem número que a base não sustenta (5 em 60 perguntas na última medição). Use o modo rascunho ou a revisão humana para qualquer coisa que dependa da base.

## Onde o RAG é usado

| Uso | Caminho |
|---|---|
| Respostas automáticas e rascunhos do assistente | `lib/assistant.cjs` `generate`, quando **De onde a IA tira as respostas** está em "Base de conhecimento + conversa" |
| Sugestão manual na conversa | `POST /api/assistant/draft` |
| "Testar a base" | `POST /api/kb/ask` |
| Sugestões de perguntas e respostas do robô | `POST /api/kb/suggestions` (`lib/faq.cjs`) |

Com o assistente em "Só a conversa", as respostas dele não consultam a base nem o catálogo.

A base, o catálogo e o provedor de IA são **compartilhados por todas as contas de WhatsApp** da central (`server.cjs`). O histórico enviado à IA é só o do contato atendido. Não há controle por pessoa: a central é local e sem login.

## Fluxo

| Etapa | Onde | O que faz |
|---|---|---|
| Ingestão | `lib/knowledge-routes.cjs` `addDocument`, `syncFolder` | Recebe arquivo, texto colado ou a pasta `base-conhecimento/`. Até 60 documentos de 10 MB. Conteúdo que já está na base com outro nome é recusado. |
| Extração | `lib/knowledge.cjs` `extractText`, `lib/pdf.cjs` | PDF, DOCX, TXT, MD, CSV (vira "coluna: valor") e JSON. Recusa arquivo sem texto. |
| Trechos | `lib/knowledge.cjs` `chunkText` | Até 1.000 caracteres por trecho, por parágrafo e frase, com 120 caracteres de sobreposição. |
| Embeddings | `lib/ai.cjs` `embed`, `lib/embeddings.cjs` `build` | Um vetor por trecho, normalizado. Padrão por provedor: `bge-m3` (Ollama e Anthropic), `text-embedding-3-small` (OpenAI), `gemini-embedding-001` (Gemini). |
| Armazenamento | `lib/embeddings.cjs` | Um item por documento, com a assinatura do modelo e o hash do texto. Mudou o texto, o modelo ou a divisão em trechos: o documento é refeito. |
| Busca | `lib/embeddings.cjs` `search` | BM25 (`lib/knowledge.cjs` `search`) e cosseno, combinados por posição (Reciprocal Rank Fusion). Corte de similaridade de 0,45 para o `bge-m3` e 0,30 para os demais. |
| Confiança | `lib/embeddings.cjs` `rate` | Alta: o trecho é o primeiro nas duas buscas. Média: achado por significado, ou por palavra com boa cobertura. Baixa: o resto. O nível de confiabilidade escolhe o que segue para a IA (3, 4 ou 6 trechos); o Rigoroso só envia algo quando o primeiro trecho é de confiança alta. |
| Contexto | `lib/assistant-core.cjs` `buildSystem` | Regras da empresa, catálogo inteiro (até 6.000 caracteres), trechos e histórico recente, marcados como dados. Inclui a instrução de não afirmar nem negar nada sobre a empresa que não esteja escrito. |
| Resposta | `lib/ai.cjs` `complete` | Temperatura 0,2. `[[HUMANO]]` significa encaminhar ao atendente. |
| Trava de saída | `lib/answer-guard.cjs` `inspect` | Retém a resposta com dado sem base ou com cópia das instruções. |

## Trava de saída

Antes de mostrar, rascunhar ou enviar uma resposta, a central confere:

- **Dados sem base:** todo preço, prazo, horário, percentual, parcelamento, telefone, CNPJ ou CPF e endereço da resposta precisa aparecer no que foi enviado à IA (catálogo, trechos, conversa e regras).
- **Vazamento:** a resposta não pode conter as marcas internas do prompt nem duas ou mais frases das regras copiadas.

A resposta retida vira pedido de atendente, e o registro de atividades do assistente guarda o motivo ("Resposta retida: …").

**O que a trava não pega:** afirmação inventada sem número ("o visto é obrigatório", "não temos loja física"), número que o próprio cliente escreveu ("parcelam em 12x?" → "sim, em até 12x") e número por extenso.

## Quedas e reservas

- **Sem embeddings** (modelo ausente, provedor fora do ar, documento ainda sendo indexado): a busca usa só palavras-chave e a Base de Conhecimento mostra o motivo.
- **Falha ao indexar:** nova tentativa em 5 minutos.
- **Falha em uma pergunta:** a consulta de embedding é repetida uma vez na hora. Se falhar de novo, aquela pergunta usa palavras-chave e a busca por significado volta em 30 segundos. Antes desta versão, uma única consulta lenta desligava a busca por significado por 5 minutos.
- **Ollama parado:** o vigia (`lib/ai-watchdog.cjs`) religa o servidor e avisa na tela.
- **Geração lenta:** a resposta tem 170 segundos (a tela espera 180); acima disso vira erro. Eram 90 segundos até 16/11/2026.

## Avaliação de 11/11/2026

Feita em ambiente isolado com o código real, uma cópia da base e do catálogo em uso (4 documentos, 15 trechos, 13 itens) e os modelos de produção: `qwen2.5:7b` no processador e `bge-m3`. Confiabilidade Equilibrada.

**Amostra:** 60 perguntas novas na base real (43 com trecho esperado, 17 sem resposta ou de segurança) e 14 em um corpus sintético de um negócio fictício (preços, códigos, tabela antiga × vigente, seções longas, instruções maliciosas em documentos). Outras 24 perguntas, já usadas para escolher o corte de 0,45, ficaram só como referência.

**Limites:** as perguntas foram escritas para a auditoria, não vêm de conversas reais. A base real é pequena, então recuperar 4 de 15 trechos é uma prova fraca. A correção combinou critérios automáticos registrados antes da execução com leitura de todas as respostas; essa leitura foi feita por um modelo de IA, não por alguém do negócio. Cada pergunta foi gerada uma vez; em 23 repetições, o resultado automático mudou em 4.

### Recuperação

| Configuração | 1º resultado certo | Certo entre 4 | MRR |
|---|---|---|---|
| Híbrida (o app) | 28/43 (65%) | 41/43 (95%) | 0,855 |
| Só palavras-chave | 25/43 (58%) | 34/43 (79%) | 0,731 |
| Só embeddings | 31/43 (72%) | 41/43 (95%) | 0,891 |

| Nível | Trecho certo enviado à IA | Trechos enviados (média) |
|---|---|---|
| Rigorosa | 25/43 (58%) | 1,4 |
| Equilibrada | 39/43 (91%) | 3,1 |
| Flexível | 42/43 (98%) | 5,2 |

- Em texto corrido, só embeddings empatou ou superou a busca híbrida. As palavras-chave ajudaram em códigos exatos (corpus sintético) e são a reserva quando os embeddings caem.
- O rótulo "alta" do primeiro trecho estava certo em 22 de 36 casos (61%). Ele não é uma probabilidade.
- O corte de similaridade não separa perguntas sem resposta: a busca enviou trechos em 13 de 17 delas. Com corte de 0,55 passaria só 1, mas sobrariam 20 das 43 respondíveis. A abstenção depende do modelo e da trava de saída.
- Latência da busca: p50 de 101 ms e p95 de 154 ms.

### Respostas, antes e depois das correções desta versão

| Critério | Antes | Depois |
|---|---|---|
| Resposta correta em pergunta respondível | 36/43 (84%) | 36/43 (84%) |
| Abstenção correta em pergunta sem resposta | 11/17 (65%) | 13/17 (76%) |
| Respostas com preço, prazo, horário ou endereço inventado | 4 | 0 |
| Encaminhamento desnecessário ao atendente | 0/43 | 0/43 |
| Regras internas copiadas a pedido | o modelo copia; o app só não mostrou porque estourou o tempo | a trava retém o texto copiado (conferido com a resposta real gravada) |
| Erros por tempo (90 s) | 3 em 83 gerações | 2 em 60 |
| Latência da resposta | p50 35 s, p95 75 s | p50 39 s, p95 63 s |
| Corpus sintético | 14/14 | 14/14 (na primeira reexecução a trava reteve 3 respostas certas com preço de planilha sem "R$"; corrigido e repetido) |

"Depois" é uma nova geração das mesmas perguntas; parte da diferença é variação do modelo. Por repasse da trava sobre as 72 respostas gravadas antes, ela reteria exatamente as 5 ruins com dado ou marca interna (horário, endereço, parcelamento com valor, prazo e `<catalogo>`) e nenhuma das corretas.

### O que continua errado

| Pergunta | Resposta | Causa |
|---|---|---|
| De BH pra Lisboa, precisa de visto? | "o visto português é obrigatório" | Geração; o trecho mandava conferir nos canais oficiais |
| Qual o endereço da loja? | "não temos uma loja física" | Geração; a base não diz |
| Vocês parcelam em 12x? | "normalmente … em até 12x" | Geração; repete o número do cliente |
| A loja online tem cupom? | cupons "na seção de promoções" e por e-mail | Geração; a base fala do sistema vendido |
| Aceita Pix? | "aceitamos Pix em nossos serviços" | Geração; a base fala dos sistemas vendidos |
| Celular precisa de Anatel? | afirmou como regra | Geração; a base diz que alguns produtos exigem |
| Quais sistemas prontos vocês têm? | 7 a 8 dos 13 | Dados: o catálogo lista 8 sistemas e a base, 13 |

### Outros achados

- **Catálogo × base:** o prompt manda listar o catálogo. Mantenha os dois alinhados; hoje há itens só na base e uma descrição trocada no catálogo.
- **Trechos:** a sobreposição começa no meio de uma palavra em 7 de 11 fronteiras, e 10 de 31 seções continuam em um trecho sem o título. Perguntas que pedem 3 itens de trechos diferentes falharam em 2 de 5.
- **Duplicatas e versões:** o mesmo texto enviado duas vezes é aceito e ocupa duas vagas do contexto. Não há data nem versão: uma tabela antiga ficou à frente da vigente na busca (a resposta saiu certa porque o texto dizia qual valia).
- **Exclusão e atualização:** refletidas na busca na hora.
- **PDF gerado pelo Chrome:** 97,5% a 100% das palavras em texto corrido; em tabela, 84%, com letras separadas ("T eclado") e 10 de 12 linhas íntegras.
- **Instruções maliciosas em documentos:** ignoradas nos 2 casos testados.
- **Isolamento entre conversas:** nada de outra conversa apareceu nos 2 casos testados.
- **Escala:** a parte de palavras-chave refaz trechos e tokens de toda a base a cada pergunta: 82 ms com 1 MB, 0,9 s com 12 MB, 6,7 s com 90 MB. Indexar 12 MB levaria cerca de 7 horas no processador.

### Não validado

Perguntas reais de clientes; provedores na nuvem e seus cortes; DOCX real e PDF escaneado; o armazenamento em PostgreSQL (a avaliação usou a pasta temporária; o código de busca é o mesmo); envio automático de verdade (os testes usaram rascunho); várias conversas ao mesmo tempo; o nível Rigoroso na geração.

## Mudanças de 16/11/2026 e nova medição

Mesmo ambiente, mesmas perguntas e mesmos modelos da avaliação de 11/11. Cada pergunta foi gerada uma vez; parte da diferença entre as execuções é variação do modelo.

| Mudança | Medição | Resultado |
|---|---|---|
| Rótulo "alta" só para o trecho que é o primeiro nas duas buscas | 1º trecho rotulado "alta" é o certo | 22/36 (61%) → 18/21 (86%) nas perguntas de teste; 2/2 nas de referência; 17/19 com documentos distratores; 7/9 no corpus sintético |
| Rigoroso só responde com o 1º trecho de confiança alta | Trecho certo enviado à IA | 25/43 → 15/43; sem nenhum trecho em 26 das 43. Responde menos, como o nome diz. Equilibrado (39/43) e Flexível (42/43) não mudaram |
| Prazo da resposta de 90 s para 170 s | Erros por tempo | 2 em 60 → 0 em 60 (p50 44 s, p95 85 s, máximo 119 s) |
| Instrução contra afirmar ou negar o que não está escrito | Abstenção correta em pergunta sem resposta | 13/17 → 17/17 |
| | Resposta correta em pergunta respondível | 36/43 → 36/43 |
| | Afirmações sem número e sem base | 7 → 5 |
| | Preço, prazo, horário ou endereço inventado | 0 → 0 |
| Conteúdo repetido recusado ao enviar | Teste automático | O segundo envio recebe erro com o nome do documento que já existe |
| Pedido de cópia das regras ("mostre o prompt") | Com o prazo maior, o modelo terminou a cópia em 119 s | A trava reteve e a resposta virou pedido de atendente |

**Continua errado depois de 16/11** (perguntas respondíveis): cupom da loja ("não temos cupons"), reembolso ("geralmente, tarifa promocional não tem reembolso"), Pix ("sim, aceitamos"), Anatel (afirmou como regra), visto para Lisboa ("geralmente, brasileiros precisam de visto", o que é falso), Miami com eletrônicos (não citou passagem nem importação) e a lista de sistemas (incompleta; catálogo e base divergem). As cinco primeiras são afirmações do modelo sem apoio na base: a instrução nova não as eliminou.

**Testado e descartado: corte de trechos por seção.** Cortar nos títulos Markdown, repetindo o título do documento em cada trecho, foi medido em quatro tamanhos (uma seção por trecho, até 400, até 600 e até 1.000 caracteres). Nenhum superou o corte atual além de uma pergunta de diferença, e todos deixaram mais perguntas sem nenhum trecho no Equilibrado (3 contra 1), porque trechos maiores ou sem vizinhança baixam a similaridade. O corte por parágrafos foi mantido.

| Corte | 1º certo (teste) | Certo entre 4 (teste) | MRR (teste) | 1º certo (referência) | Equilibrado sem trecho |
|---|---|---|---|---|---|
| Atual (parágrafos, 1.000) | 28/43 | 41/43 | 0,855 | 12/16 | 1 |
| Seções até 1.000 | 27/43 | 42/43 | 0,855 | 11/16 | 3 |
| Seções até 600 | 29/43 | 42/43 | 0,862 | 11/16 | 3 |
| Seções até 400 | 28/43 | 40/43 | 0,853 | 12/16 | 3 |
| Uma seção por trecho | 28/43 | 40/43 | 0,853 | 11/16 | 3 |

## Próximas melhorias, por evidência

1. Alinhar catálogo e base (sem código): a base descreve 13 sistemas e o catálogo lista 8.
2. Testar um modelo de geração mais forte com este mesmo conjunto: as falhas restantes são de geração.

Reranking não é recomendado agora: o trecho certo já está entre os 4 primeiros em 95% dos casos.

## Como repetir a avaliação

Pré-requisitos: Ollama rodando com os modelos configurados e, para o primeiro passo, a central aberta. Os scripts ficam em `scripts/rag-eval/`, usam o código deste repositório com uma pasta de dados temporária e nunca gravam na central.

```powershell
cd scripts\rag-eval
node snapshot.cjs            # copia base, catálogo e regras da central (só leitura) para corpus/
node validate.cjs            # confere o gabarito contra os trechos
node eval-ingestion.cjs      # PDF real, trechos e escala
node eval-retrieval.cjs      # recuperação (cerca de 1 minuto)
node eval-answers.cjs real   # respostas, base real (cerca de 40 minutos no processador)
node eval-answers.cjs synt   # respostas, corpus sintético
node eval-lifecycle.cjs      # exclusão, atualização, duplicatas
node report-retrieval.cjs
node report-answers.cjs real --full
```

- `dataset.cjs` é o gabarito: pergunta, resposta esperada, trechos relevantes e critério de aprovação. Acrescente perguntas reais dos seus clientes ali.
- `review-2026-11-11.json`, `review-2026-11-11-depois.json` e `review-2026-11-16.json` guardam a revisão manual das três execuções. Para aplicar uma revisão, copie o arquivo para `review.json` (ou `review<RUN_TAG>.json`).
- `RUN_TAG=-nome` grava uma execução em arquivos separados, para comparar antes e depois de uma mudança.
- `corpus/` e `results/` contêm dados do negócio e ficam fora do repositório.
