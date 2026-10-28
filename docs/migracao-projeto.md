# Projeto independente em projects/whatsapp-central

Pedido de 28/10/2026: preparar a central em `C:\Users\default.LAPTOP-K8F2QHAF\projects\whatsapp-central`, com abertura do webapp por um botão e commit Git. O usuário também forneceu uma nova referência de dashboard escuro com navegação lateral, cards e painel à direita.

Restrição explícita: uso pessoal, uma conta, no próprio computador. O desenho não transforma o aplicativo em SaaS e não inclui planos, cobrança, gestão de usuários ou indicadores fictícios de IA.

## Entrega

- Código e testes no novo repositório.
- `Abrir WhatsApp.cmd`, atalho da área de trabalho e comando `npm start` iniciam a infraestrutura e abrem o webapp.
- Estado local da conta copiado como dados ignorados; volumes e instância existentes preservados.
- Integração do Milhas atualizada para o caminho novo, com adaptador portátil versionado neste repositório.
- Visual da referência aplicado às funções existentes e aos indicadores reais. O desenho não representa ativação de IA, RAG ou APIs de terceiros.

## Verificação antes do commit

- [x] Suíte Node da central e do Milhas.
- [x] Sintaxe dos scripts, Docker Compose e dados pessoais excluídos pelo Git.
- [x] Servidor executando a partir da pasta nova, três serviços saudáveis e conta conectada.
- [x] Botão abre o webapp sem criar segunda sessão.
- [x] Visual conferido em navegador e alterações preparadas para commit.

Validação: painel em 1536 × 960 e janela estreita de 650 × 850, sem rolagem horizontal; texto das mensagens e nomes com 14 px. O iniciador foi executado a partir da pasta nova, e a retomada do pareamento foi confirmada sem novo QR. Rascunhos conhecidos foram preservados durante a atualização. Uma regressão cobre chaves duplicadas na confirmação de leitura do histórico sincronizado.
