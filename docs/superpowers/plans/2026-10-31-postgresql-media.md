# PostgreSQL e prévias de mídia

**Objetivo:** usar PostgreSQL como persistência da central, migrando os dados locais, e apresentar prévias de imagens/vídeos recebidos e selecionados para envio.

**Arquitetura:** banco `whatsapp_central` e usuário próprio no PostgreSQL já existente. Um adaptador preserva os contratos de leitura/atualização dos serviços e guarda os documentos de estado em JSONB, com transações e bloqueio de linha. A porta HTTP é reservada antes de migrar; a aplicação responde somente após carregar contas/configuração do banco. Credenciais usam BYTEA com criptografia DPAPI antes da gravação; nenhum segredo de IA é importado em texto puro. O texto extraído da base fica no PostgreSQL, e arquivos binários de mídia permanecem em disco com referências. Somente a configuração de conexão e os segredos de inicialização ficam fora do banco.

- [x] Criar testes de integração PostgreSQL para transações concorrentes, rollback, migração idempotente, credenciais cifradas, contas e isolamento entre contas.
- [x] Implementar adaptador, esquema e migração transacional verificada; preservar os arquivos de origem e interromper inicialização em falhas, sem fallback local silencioso.
- [x] Integrar armazenamento nos serviços de IA, atendimento, produtos, base e contas; preparar banco/usuário e conexão local no inicializador.
- [x] Adicionar miniaturas seguras de mídia recebida e prévias de anexos selecionados com descarte de URLs temporárias.
- [x] Validar com PostgreSQL real, testes existentes, navegador, migração real e verificação do serviço local; documentar backup/restauração e limites.

Migração real ativada: serviço confirmou `storage=postgresql`, WhatsApp conectado, 10 arquivos de origem preservados por SHA-256 e nenhum campo de chave em texto nos documentos de configuração. Prévias têm cache de 24 entradas/32 MiB, carregamento próximo à área visível com duas requisições simultâneas e descarte ao trocar de conversa. Testes focados de mídia/frontend e os três cenários de navegador passaram. A bateria PostgreSQL real foi repetida após reativar o Docker Desktop. O inicializador reutiliza a imagem do conector existente para evitar rebuild desnecessário em máquinas com pouca memória.

A migração usa marcador no banco e não sobrescreve dados já importados. Banco e credenciais do conector Evolution não são modificados. Prévia de vídeo não reproduz nem baixa automaticamente o arquivo completo.
