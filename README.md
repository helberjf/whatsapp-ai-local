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
- As fotos dos contatos carregam conforme aparecem na lista. Quando a privacidade do contato impede o acesso, as iniciais continuam visíveis.
- Os nomes disponíveis nos contatos do WhatsApp são carregados automaticamente, com cache de cinco minutos. Em **Conexão**, use **Atualizar nomes do WhatsApp** para buscar novamente. O conector pode entregar nome de perfil em vez do nome da agenda; identificadores privados sem correspondência explícita continuam numéricos. Nomes não são adivinhados a partir desses identificadores.
- Os quatro indicadores usam uma faixa compacta para dar mais altura às conversas.
- Cada áudio aparece em um card: **Carregar áudio** prepara o player, que oferece reprodução, posição, duração e velocidades **1×, 1,5× e 2×**. O áudio é baixado ao clicar; a transcrição continua disponível separadamente.
- A seta **⌄** em cada mensagem abre **Copiar texto** e **Encaminhar**. A cópia de áudio usa a transcrição disponível. Para encaminhar, escolha o destinatário e confirme no diálogo. Textos, imagens, áudios, vídeos, documentos e figurinhas são suportados, com anexos de até 10 MB. Tipos especiais como contato, localização e mensagem de sistema permanecem no WhatsApp original.
- **Carregar mensagens anteriores** pagina o histórico sincronizado. A primeira sincronização depende do WhatsApp; ela não garante a importação de todo o histórico antigo. Identificadores privados `@lid` podem aparecer quando o WhatsApp ainda não disponibilizou o nome/telefone.

O escopo é atendimento individual. Além do editor manual, o robô opcional pode responder às palavras-chave configuradas por você. Disparos, grupos e regras de cobrança/renovação do Mapa Hóspede não fazem parte desta central.

## Mensagens programadas

Abra **Mensagens programadas** no menu ou **Programar** no editor da conversa. Escolha o destinatário, escreva o texto, informe a data/hora e clique em **Programar mensagem**. O horário é convertido do fuso deste computador e salvo como um instante com fuso definido. A lista permite editar, cancelar e remarcar; mensagens em envio, enviadas ou sem confirmação não podem ser alteradas.

O agendamento funciona com o navegador fechado, desde que **computador, central e WhatsApp estejam ligados e conectados**. Se estiver sem conexão no horário, o sistema aguarda por até 15 minutos. Depois desse prazo, marca **Não enviada · remarcar**, sem mandar uma mensagem muito atrasada. A programação é preservada ao reiniciar.

O envio é reservado em disco antes de chamar o conector. Se a central for interrompida durante essa etapa ou o envio não for confirmado, aparece **Envio sem confirmação**. Confira a conversa antes de programar novamente; não há repetição automática de um envio incerto.

Nesta versão, o agendamento é para **texto**. Anexos do editor não são incluídos. O rascunho original é limpo somente quando corresponde ao texto programado e continua sem alterações; edições posteriores permanecem no editor.

O encaminhamento preserva o conteúdo original, enviado como uma nova mensagem. A Evolution 2.3.7 não expõe o selo nativo “Encaminhada”; a central não simula esse selo. Falhas ao carregar a origem permitem nova tentativa; após o envio começar, a proteção contra duplicação mantém o mesmo identificador.

## Transcrever áudios

No balão de áudio, use **Transcrever**. O padrão é **Whisper local**, modelo **base**, em português. A transcrição aparece no próprio balão e pode ser copiada. Fechar a conversa não cancela o processamento. Os resultados ficam salvos localmente e reaparecem ao abrir a conversa.

Em **Transcrição de áudios**, escolha o modelo e o idioma. `tiny` usa menos recursos; modelos maiores exigem mais memória e tempo de CPU. A instalação desta máquina já possui Python, Whisper, FFmpeg e o modelo base. O processamento aceita áudios de até **10 MB e 10 minutos**, com um áudio por vez e até 20 na fila. Os arquivos temporários são apagados depois do processamento. Uma interrupção marca o trabalho como falho; uma nova tentativa depende do seu clique.

Em outra instalação Windows, instale FFmpeg no PATH e prepare o Python:

```powershell
python -m pip install openai-whisper
python -c "import whisper; whisper.load_model('base')"
```

O segundo comando baixa o modelo. Para usar outro modelo, substitua `base` pelo nome escolhido. A central procura Python 3.10 em `%LOCALAPPDATA%\Programs\Python\Python310\python.exe` e, depois, `python.exe` no PATH. Defina `WHATSAPP_WHISPER_PYTHON` ou `WHATSAPP_FFMPEG` antes de abrir a central para indicar executáveis diferentes.

**IA (OpenAI)** é uma alternativa selecionada por áudio. Cole sua chave de API na configuração de transcrição. Essa opção envia o áudio à OpenAI usando `gpt-transcribe`; depende de internet e de uma conta de API habilitada. O Whisper local não precisa dessa chave. Não há troca automática do Whisper para a IA em caso de falha.

A chave fica **criptografada no banco SQLite `data/credentials.sqlite`**, com DPAPI do Windows no escopo do usuário atual. A interface recebe somente a indicação de chave configurada. O segredo não fica nos argumentos de processos, nos logs nem nos metadados de transcrição. Para trocar de usuário/computador, informe a chave novamente; copiar o banco não transfere a capacidade de descriptografá-la.

Referências de integração: [Whisper oficial](https://github.com/openai/whisper) e [transcrição de arquivos da OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text). A pasta `video-mp3-transcript` foi consultada: ela contém conversão com FFmpeg, sem um transcritor pronto.

## CRM e robô por palavras-chave

Abra **CRM** no menu para acompanhar contatos por etapa, anotar observações, definir o próximo contato e abrir a conversa. As mudanças e o histórico ficam neste computador. A organização foi adaptada do CRM do `menu-hospede` para a sua conta pessoal.

Em **Automações**, cadastre o nome da regra, palavras ou frases e a resposta. Escolha entre encontrar um trecho ou uma palavra/frase inteira. A comparação ignora maiúsculas e acentos; a primeira regra correspondente prevalece. O simulador mostra o resultado sem enviar nada ao WhatsApp.

O robô começa **desligado e sem regras**. Após salvar suas regras e ativá-lo, ele acompanha mensagens de texto novas mesmo com o navegador fechado, enquanto o computador, Node e Docker estiverem ativos. Mensagens antigas, mensagens suas, grupos e mídias não geram respostas. É possível pausar o robô para um contato no atendimento/CRM. O intervalo mínimo entre respostas ao mesmo contato é configurável.

O identificador da mensagem é reservado em disco antes do envio para evitar duplicação. Se o envio ficar sem confirmação, o registro aparece no histórico e não é reenviado automaticamente. Ao reabrir a central, mensagens do período em que ela esteve desligada não disparam respostas retroativas.

## Usar o computador como servidor

O Node fica em segundo plano; fechar o navegador não encerra o conector. Mantenha o computador ligado, com internet, sem suspensão e com Docker ativo.

- **Ativar inicio com Windows.cmd** cria um atalho na pasta Inicializar do seu usuário. A central e Docker iniciam ao entrar no Windows, sem abrir o navegador.
- **Desativar inicio com Windows.cmd** remove apenas esse atalho.
- **Parar WhatsApp.cmd** para a central e seus três containers, preservando sessão e histórico.
- **Iniciar WhatsApp.cmd** recupera os serviços e reutiliza a sessão. O botão **Desconectar** encerra o vínculo e exige novo pareamento.

A central está disponível apenas neste computador, em `127.0.0.1:8766`. A API escuta em `127.0.0.1:8767`; banco e cache não publicam portas no Windows. Não é necessário domínio, roteador ou VPS externa para este uso local.

## Base de Conhecimento, Produtos e Assistente de IA

- **Base de Conhecimento (RAG):** envie PDF, DOCX, TXT, MD, CSV ou JSON (até 10 MB) ou cole um texto. PDFs escaneados (só imagem) não têm texto e são recusados com aviso. Cada documento é dividido em partes e a busca por relevância (BM25, sem acentos nem plural) recupera os trechos certos para cada pergunta. Em **Testar a base** você vê a resposta e os trechos usados. **A base já vem pronta:** os arquivos da pasta `base-conhecimento/` (serviços, sistemas, passagens para Europa, Brasil e EUA, importação da China e regras de atendimento) entram sozinhos ao abrir a central. Edite esses arquivos ou copie novos para a pasta e use **Sincronizar pasta**. Só falta informar a chave de API em **Assistente de IA** para a IA redigir as respostas; sem a chave a base já mostra os trechos encontrados.
- **Assistente de IA:** informe provedor (OpenAI, Anthropic, Google Gemini, Ollama ou API compatível com OpenAI), modelo e chave. A chave fica em `data/ai.json` e não volta para a tela. Sem IA configurada a base continua funcionando e mostra os trechos encontrados. Ao usar a IA, a pergunta e os trechos (ou os documentos escolhidos na importação) são enviados ao provedor; com Ollama tudo fica neste computador.
- **Produtos e serviços:** o formulário segue o da loja (`ecommerce`): título, tipo (produto ou serviço), categoria, descrição, preço, estoque, desconto %, garantia, ativo, frete grátis, frete e dimensões e até 5 fotos. A vitrine tem filtros por categoria e tipo e selos de desconto, frete grátis e estoque. O catálogo inicial (`produtos-iniciais.json`: criação de sites e sistemas, passagens para Europa, Brasil e EUA, importação da China e os sistemas prontos) é carregado na primeira abertura, sem preços (aparecem como "sob consulta"); edite para incluir valores. **Usar na conversa** coloca a ficha pronta (e a foto, como anexo) no editor da conversa aberta; você revisa e envia. Também há a aba **Produtos** no painel da conversa.
- **Importar da base (IA):** a IA lê os documentos escolhidos e propõe a lista de produtos; você revisa, edita e confirma. Itens já cadastrados (mesmo código ou nome) aparecem desmarcados e, se marcados, atualizam o existente. O texto dos documentos é tratado como dado, e a saída da IA é validada antes de aparecer.
- **Contatos (CRM):** lista de todos os contatos com situação, etiquetas e notas; clique para abrir o atendimento. A busca do topo procura em conversas, produtos e documentos.

A IA apenas sugere ou propõe; nenhuma mensagem é enviada ao cliente sem o seu clique em Enviar.

## Arquivos e persistência

- `server.cjs`, `lib/`: servidor HTTP, adaptação Evolution e metadados do atendimento.
- `public/`: interface sem dependências externas.
- `infra/compose.yaml`: Evolution API **v2.3.7**, PostgreSQL 16 e Redis 7.
- `scripts/`: configuração, início, parada e início com Windows.
- `data/config.json` e `infra/.env`: segredos gerados localmente; não compartilhe esses arquivos.
- `data/atendimento.json`: notas, etiquetas, respostas rápidas e registros de envio para evitar duplicação.
- `data/atendimento.json` também guarda CRM, regras e histórico do robô, configurações públicas e resultados de transcrição.
- `data/atendimento.json` guarda também mensagens programadas, situação de cada envio e identificadores de encaminhamento para evitar duplicação.
- `data/credentials.sqlite`: chave da OpenAI criptografada com a proteção do usuário Windows.
- `data/knowledge.json` e `data/knowledge/`: documentos da base de conhecimento. `data/produtos.json` e `data/product-images/`: produtos e fotos. `data/ai.json`: configuração da IA (inclui a chave; não compartilhe).
- `data/server.log`, `data/server.err.log` e `data/startup.log`: diagnóstico local.

Sessão e mensagens ficam nos volumes Docker `whatsapp-local_instances`, `whatsapp-local_postgres_data` e `whatsapp-local_redis_data`. **Não remova esses volumes nem use `docker compose down -v` para uma parada normal.** Copiar apenas a pasta do projeto não copia o banco nem a sessão desses volumes.

O nome interno Docker permanece `whatsapp-local` para reutilizar os volumes e o pareamento existentes durante a mudança de pasta. `data/`, `infra/.env` e atalhos `.lnk` ficam fora do Git. O código pode ser versionado sem publicar os dados da conta.

Neste computador, o Avast inspeciona HTTPS. `scripts/windows-ca.ps1` valida a conexão com o WhatsApp usando a confiança existente do Windows, exporta somente o certificado público da raiz já confiada e o disponibiliza ao Node do conector e da central via `NODE_EXTRA_CA_CERTS`. A validação TLS permanece ativa. Nenhuma chave privada do Windows é exportada.

## Testar e diagnosticar

```powershell
node --test tests/*.test.cjs
docker compose -f infra/compose.yaml ps
docker compose -f infra/compose.yaml logs --tail=50 evolution
```

Os testes usam um servidor Evolution fictício, sem enviar mensagens reais. O pareamento e o recebimento de conversas foram verificados com sua sessão, após sua leitura do QR em 28/10/2026. Envios de teste para seus contatos não foram realizados.

Na atualização de 28/10/2026, passaram 73 testes da central. Foram verificados Whisper com áudio sintético e áudio real pela interface, fotos reais, CRM, configuração de chave, simulador e preservação de rascunho. A integração OpenAI foi testada por contrato com resposta controlada; o uso real depende da sua chave de API.

A atualização seguinte de agendamento, nomes, áudio e encaminhamento passou **124 testes da central**. O agendamento e os envios foram exercitados com conector controlado; na sessão real foram conferidos nomes, áudio, menu e formulários, sem enviar mensagens de teste para os contatos.

Contrato e infraestrutura conferidos na [fonte oficial da Evolution 2.3.7](https://github.com/evolution-foundation/evolution-api/tree/2.3.7). A origem local permanece sem alterações.
