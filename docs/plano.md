# Plano de implementação — WhatsApp Local

**Objetivo:** central independente no Windows, sessão persistente e acesso opcional pelo Milhas.

**Arquitetura:** Node HTTP em loopback, adaptador Evolution derivado do módulo do menu-hospede, armazenamento local para atendimento e Docker Compose para conector/banco/cache.

**Stack:** Node 22+, HTML/CSS/JS, Evolution API 2.3.7, PostgreSQL 16 e Redis 7.

- [x] Escrever e executar testes de contrato e segurança antes da implementação.
- [x] Implementar `lib/evolution.cjs`, `lib/store.cjs` e `server.cjs`, verificando estado, QR, conversas, mensagens, mídia e metadados.
- [x] Criar `public/index.html`, `public/app.css` e `public/app.js` com central, QR renovável, respostas rápidas e atendimento.
- [x] Criar `infra/compose.yaml`, configuração local e scripts de início, parada e início com Windows; subir somente a pilha exclusiva `whatsapp-local`.
- [x] Implementar e testar `whatsapp-local.cjs` e botão opcional no Milhas para reutilizar a mesma central.
- [x] Executar ambas as suítes, verificar a interface e realizar pareamento por QR pelo usuário.

Os arquivos são entregues diretamente, pois o Milhas não é um checkout Git. O projeto de origem é somente leitura. Testes usam dados fictícios e não enviam mensagens para contas reais.

O usuário leu o QR e o conector confirmou `connected`. A interface foi adaptada à referência posterior do WhatsApp Web escuro e verificada em janela estreita e em 1366 × 768. A revisão independente encontrou e originou testes para rascunhos assíncronos, paginação e preservação de leitura. A confiança HTTPS foi ajustada para o certificado Avast já confiado no Windows, sem desativar TLS.

Verificação final em 28/10/2026: 17 testes da central e 18 do Milhas passaram; JavaScript validado por `node --check`; três containers saudáveis; iniciador testado no Windows PowerShell 5; acesso opcional do Milhas retornou a central já iniciada; estado real `connected` confirmado. Os testes de regressão também cobrem edição de legenda durante leitura de anexo e concorrência entre paginação e polling. A opção de início com Windows foi criada e permanece disponível para ativação pelo usuário.
