# WhatsApp Local — 28/10/2026

Pedido: extrair a central WhatsApp de `projects/menu-hospede` para um projeto independente e deixar acesso opcional no Milhas. O computador Windows hospeda tudo; o QR é exibido no computador e lido pelo celular.

Atualização visual solicitada depois do pareamento: seguir a referência do WhatsApp Web escuro, priorizando leitura. A interface passa a ocupar a janela inteira, com lista à esquerda, conversa ampla, editor fixo embaixo e painel de atendimento recolhível. Em janelas estreitas, alterna entre lista e conversa. Fonte das mensagens: 14 px; nomes da lista: 16 px. O polling preserva rascunhos e a posição de leitura.

## Solução

Servidor Node sem dependências npm em `127.0.0.1:8766`, interface HTML/CSS/JS própria e Evolution API v2.3.7 em Docker, como no projeto de origem. PostgreSQL, Redis e sessão possuem volumes persistentes exclusivos. A API fica em `127.0.0.1:8767`. Segredos permanecem em arquivo local ignorado, nunca na interface.

A central oferece pareamento, estado real, atualização do QR, desconexão explícita, busca e filtro de conversas, histórico paginado, envio de texto e anexos, leitura de mídia, etiquetas, situação do atendimento, notas e respostas rápidas. Mensagens ficam no banco da Evolution; metadados do atendimento ficam em arquivo local com gravação atômica. Consultas periódicas locais substituem webhooks públicos. As funções de hospedagem, cobrança e renovação do Mapa Hóspede não se aplicam ao projeto independente.

O Milhas oferece um botão que inicia e abre o projeto irmão, reutilizando a mesma instância. O iniciador independente também inicia Docker e a pilha, aguarda saúde e abre a central. Inicialização com Windows é uma opção explícita por script; o computador precisa permanecer ligado e sem suspensão para funcionar continuamente.

## Verificação

Testes Node com servidor HTTP Evolution de teste verificam contrato v2.3.7 (incluindo `text` no envio), QR, estado, paginação, erros, proteção de origem/token e persistência. Testes existentes do Milhas continuam passando. Verificação real: serviços Docker saudáveis, QR retornado pela Evolution e interface no navegador. O estado conectado só será informado depois do pareamento pelo usuário.
