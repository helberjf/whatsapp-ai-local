# Seleção de modelos e credenciais de IA

**Objetivo:** permitir escolher provedor e modelo, colar a chave e salvá-la criptografada no SQLite existente.

**Arquitetura:** catálogo de provedores em módulo próprio, sugestões iniciais e consulta explícita ao catálogo da conta pelo servidor. Campo manual preserva modelos privados e APIs compatíveis. Credenciais ficam separadas por provedor com Windows DPAPI; respostas HTTP contêm somente indicadores de existência. Migração verificada da credencial antiga antes de removê-la.

**Stack:** Node.js, node:sqlite, Windows DPAPI, JavaScript do navegador, node:test e Playwright.

- [x] Escrever e executar testes que falhem para catálogo, consulta paginada, isolamento das chaves, migração e criptografia real.
- [x] Implementar `lib/ai-providers.cjs`, adaptar `lib/ai.cjs` e `lib/credentials.cjs`, adicionar `POST /api/ai/models` em `lib/knowledge-routes.cjs`.
- [x] Adicionar seleção de modelos, campo manual, carregamento explícito e estado da chave por provedor em `public/index.html` e `public/pages.js`.
- [x] Verificar troca de provedor, preservação do modelo salvo, falha de consulta, remoção isolada e ausência de segredos nas respostas em testes HTTP e Playwright.
- [x] Atualizar README e executar `node --test --test-concurrency=1 tests/*.test.cjs` (293 testes aprovados), os três testes Playwright da funcionalidade e `git diff --check`.

A revisão também verificou vínculo persistente de chave/endereço por provedor e remoção independente via `DELETE /api/ai/key`. Os testes do navegador aguardam a inicialização da central e as respostas HTTP, sem pausas fixas.

Critérios: consulta não salva chave nem muda provedor ativo; chaves nunca entram em URL ou JSON de configuração; falhas do provedor não refletem segredos; seleção de outro provedor limpa chave colada e endereço anterior. Não listar modelos de áudio, imagem, embedding ou outros incompatíveis quando a API informa capacidades.
