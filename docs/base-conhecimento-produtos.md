# Base de conhecimento, produtos e IA — 29/10/2026

Pedido: implementar a base de conhecimento, aproximar a interface da referência WhatsAI sem perder o CRM existente, criar a aba Produtos (cadastro, envio da ficha na conversa e importação do RAG por IA) e retirar o acesso pelo Milhas. O pedido anterior de reconstruir o sistema em Next.js foi cancelado pelo usuário; tudo continua no servidor Node sem dependências npm.

## Decisões

- **Milhas removido:** `integrations/milhas/`, o teste do iniciador e o link na barra lateral foram excluídos. A central abre pelos atalhos `.cmd` e em `127.0.0.1:8766`.
- **Base (RAG) sem custo obrigatório:** a recuperação usa BM25 local (sem acentos, plural simples), então funciona sem API. A IA só redige a resposta a partir dos trechos recuperados. Embeddings/pgvector não foram adotados nesta versão.
- **Formatos:** TXT, MD, CSV, JSON e DOCX (leitor ZIP próprio com limite de descompressão). PDF é recusado com orientação, pois ler PDF sem biblioteca é pouco confiável.
- **IA:** OpenAI, Anthropic, Gemini, Ollama e API compatível com OpenAI. A chave fica em `data/ai.json` (modo 0600) e nunca é devolvida à interface.
- **Prompt injection:** documentos e perguntas entram como dados dentro de `<contexto>` / `<documento>`; a saída da importação é validada campo a campo e revisada pelo usuário antes de salvar.
- **A IA não envia nada:** produto, resposta da base e rascunhos só preenchem o editor; o envio continua sendo o clique do usuário.
- **Interface:** menu Dashboard / Conversas / Contatos (CRM) / Pendentes / Concluídos / Base de Conhecimento / Produtos / Assistente de IA / Respostas rápidas / Conexão / Configurações, cartões de status do sistema, topo com WhatsApp, IA e busca global, seis indicadores reais e painel direito com abas Contato, Produtos, Assistente, Respostas e Conexão.

## Verificação

Testes Node: servidor (rotas de base, IA, produtos, extração, imagens), front (VM com DOM simulado) e os testes anteriores. Prévia visual com Evolution e IA simulados conferida em 1536 × 960: dashboard, base, perguntas, importação por IA, produtos e uso na conversa.
