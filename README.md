# WhatsApp Central

Aplicativo pessoal para usar sua conta do WhatsApp neste computador Windows. Adaptado do módulo Evolution API do `menu-hospede`, com interface escura, menu lateral, resumo das conversas e painel de organização. Os dados e a sessão ficam neste computador; o projeto não inclui planos, cobrança ou gestão de usuários.

## Abrir

Use o atalho **WhatsApp Central** na área de trabalho ou dê dois cliques em **Abrir WhatsApp.cmd**, na pasta deste projeto. O iniciador prepara a configuração na primeira execução, inicia o Docker Desktop, sobe os serviços locais, inicia a central em segundo plano e abre [o webapp](http://127.0.0.1:8766/).

Nesta máquina, o projeto fica em `C:\Users\default.LAPTOP-K8F2QHAF\projects\whatsapp-central`. Para recriar o botão em outro computador, execute **Criar atalho na area de trabalho.cmd**. Também é possível usar `npm start` para iniciar os serviços e abrir o webapp. `npm run serve` executa somente o servidor Node, quando o conector já está ativo.

No primeiro uso, abra **Conexão → Conectar WhatsApp**. O QR aparece na tela do computador. No celular, vá em **WhatsApp → Aparelhos conectados → Conectar aparelho** e leia o QR. Depois do pareamento, o indicador muda para **Conectado** e a sessão fica salva. Reabrir a central normalmente não exige outro QR.

Requisitos: Windows, Node.js 22 ou mais recente, Docker Desktop com engine Linux e internet. Esses componentes já estavam instalados neste computador e foram usados na verificação.

## Conversas

- Lista com busca por nome, telefone ou etiqueta, filtro de não lidas e situação.
- Em janela ampla, menu lateral, indicadores reais e três áreas: lista, conversa e painel de organização. Até 760 px, selecione uma conversa e use **←** para voltar à lista.
- Texto de 14 px nas mensagens e 16 px nos contatos; balões recebidos escuros e enviados verdes.
- Texto e anexos de até 10 MB. **Ctrl+Enter** envia; as respostas rápidas apenas preenchem o editor.
- O painel reúne situação, etiquetas, notas, respostas rápidas e conexão. Em janelas menores, o botão de detalhes abre esse painel. As notas não são enviadas ao contato.
- **Carregar mensagens anteriores** pagina o histórico sincronizado. A primeira sincronização depende do WhatsApp; ela não garante a importação de todo o histórico antigo. Identificadores privados `@lid` podem aparecer quando o WhatsApp ainda não disponibilizou o nome/telefone.

O escopo é atendimento individual. Chatbot, disparos, grupos e regras de cobrança/renovação do Mapa Hóspede não foram ativados nesta central. O envio ocorre somente por ação no editor.

## Usar o computador como servidor

O Node fica em segundo plano; fechar o navegador não encerra o conector. Mantenha o computador ligado, com internet, sem suspensão e com Docker ativo.

- **Ativar inicio com Windows.cmd** cria um atalho na pasta Inicializar do seu usuário. A central e Docker iniciam ao entrar no Windows, sem abrir o navegador.
- **Desativar inicio com Windows.cmd** remove apenas esse atalho.
- **Parar WhatsApp.cmd** para a central e seus três containers, preservando sessão e histórico.
- **Iniciar WhatsApp.cmd** recupera os serviços e reutiliza a sessão. O botão **Desconectar** encerra o vínculo e exige novo pareamento.

A central está disponível apenas neste computador, em `127.0.0.1:8766`. A API escuta em `127.0.0.1:8767`; banco e cache não publicam portas no Windows. Não é necessário domínio, roteador ou VPS externa para este uso local.

## Acesso pelo Milhas

No Milhas, o link **WhatsApp Local ↗** inicia e abre esta mesma central. O adaptador procura `%USERPROFILE%\projects\whatsapp-central`; para outro local, defina `WHATSAPP_CENTRAL_DIR` antes de iniciar o Milhas. As duas entradas usam a mesma instância e a mesma sessão. Se abrir somente o HTML do Milhas como arquivo, inicie a central pelo `.cmd` antes de usar o link. A cópia portátil do adaptador fica em `integrations/milhas/`.

## Arquivos e persistência

- `server.cjs`, `lib/`: servidor HTTP, adaptação Evolution e metadados do atendimento.
- `public/`: interface sem dependências externas.
- `infra/compose.yaml`: Evolution API **v2.3.7**, PostgreSQL 16 e Redis 7.
- `scripts/`: configuração, início, parada e início com Windows.
- `integrations/milhas/`: adaptador opcional para iniciar e abrir esta central a partir do Milhas.
- `data/config.json` e `infra/.env`: segredos gerados localmente; não compartilhe esses arquivos.
- `data/atendimento.json`: notas, etiquetas, respostas rápidas e registros de envio para evitar duplicação.
- `data/server.log`, `data/server.err.log` e `data/startup.log`: diagnóstico local.

Sessão e mensagens ficam nos volumes Docker `whatsapp-local_instances`, `whatsapp-local_postgres_data` e `whatsapp-local_redis_data`. **Não remova esses volumes nem use `docker compose down -v` para uma parada normal.** Copiar apenas a pasta do projeto não copia o banco nem a sessão desses volumes.

O nome interno Docker permanece `whatsapp-local` para reutilizar os volumes e o pareamento existentes durante a mudança de pasta. `data/`, `infra/.env` e atalhos `.lnk` ficam fora do Git. O código pode ser versionado sem publicar os dados da conta.

Neste computador, o Avast inspeciona HTTPS. `scripts/windows-ca.ps1` valida a conexão com o WhatsApp usando a confiança existente do Windows, exporta somente o certificado público da raiz já confiada e o disponibiliza ao Node do conector via `NODE_EXTRA_CA_CERTS`. A validação TLS permanece ativa. Nenhuma chave privada do Windows é exportada.

## Testar e diagnosticar

```powershell
node --test tests/*.test.cjs
docker compose -f infra/compose.yaml ps
docker compose -f infra/compose.yaml logs --tail=50 evolution
```

Os testes usam um servidor Evolution fictício, sem enviar mensagens reais. O pareamento e o recebimento de conversas foram verificados com sua sessão, após sua leitura do QR em 28/10/2026. Envios de teste para seus contatos não foram realizados.

Contrato e infraestrutura conferidos na [fonte oficial da Evolution 2.3.7](https://github.com/evolution-foundation/evolution-api/tree/2.3.7). A origem local permanece sem alterações.
