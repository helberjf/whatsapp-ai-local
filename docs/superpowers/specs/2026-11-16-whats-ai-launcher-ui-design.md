# Whats AI — abertura visual sem console

## Objetivo

Ao abrir o Whats AI pelo atalho do Windows, mostrar uma janela compacta e agradável de inicialização em vez da saída extensa do terminal. A janela deve acompanhar o trabalho real do launcher, abrir a Central quando ela estiver pronta e permanecer visível com uma mensagem clara se houver falha.

## Escopo

- Criar uma interface de carregamento nativa para Windows, inspirada na abertura do ModeloIA.
- Ocultar as janelas de console no fluxo normal iniciado pelo atalho.
- Preservar o launcher atual e o arquivo `.cmd` como caminho de diagnóstico manual.
- Preservar o argumento `-NoBrowser` usado pela inicialização automática.
- Registrar a saída técnica em `data/launcher.log`.
- Atualizar os atalhos da área de trabalho e da inicialização automática para o novo fluxo.

Não fazem parte deste trabalho: empacotar o Whats AI como Electron, alterar a tela web da Central ou modificar a forma como Docker, PostgreSQL, Evolution e o servidor são iniciados.

## Abordagem escolhida

Usar WPF pelo Windows PowerShell, disponível no ambiente já exigido pelo projeto. Um pequeno iniciador invisível chama o script WPF sem exibir console. A interface executa o launcher existente como processo filho oculto, captura `stdout` e `stderr`, atualiza o estado visual e grava o log completo.

Essa abordagem é preferível a `mshta`, que depende de tecnologia antiga, e a Electron, que adicionaria uma distribuição pesada apenas para a abertura.

## Componentes

### Iniciador invisível

O arquivo `scripts/open-central-ui.vbs`, executado pelo `wscript.exe`, inicia `powershell.exe` com `-WindowStyle Hidden` e o script `scripts/start-ui.ps1`. Ele encaminha `-NoBrowser` quando necessário. O `.cmd` canônico continua chamando o launcher textual atual para diagnóstico.

### Janela WPF

A janela terá identidade visual do Whats AI: fundo escuro, logotipo existente, anel animado, título, texto de estado e barra de progresso. Será compacta, centralizada e não abrirá uma segunda janela de terminal.

Os estados exibidos serão:

1. Preparando configurações.
2. Iniciando serviços.
3. Conectando ao WhatsApp.
4. Abrindo a Central.

O progresso representa etapas concluídas, não uma estimativa de tempo. Enquanto uma etapa longa estiver em andamento, a animação continuará ativa.

### Adaptador de processo

O script visual executa `node scripts/open-central.cjs` ocultamente, com diretório de trabalho definido na raiz do projeto. As linhas já produzidas pelo launcher serão convertidas em estados visuais por marcadores estáveis: configuração pronta inicia a etapa 2; preparação da pilha inicia a etapa 3; banco pronto inicia a etapa 4; e a mensagem de Central pronta ou reutilizada conclui o progresso. Linhas desconhecidas não aparecem na interface, mas continuam no log.

## Fluxo

1. O usuário abre o atalho Whats AI.
2. O iniciador invisível abre somente a janela WPF.
3. A janela inicia o launcher atual em segundo plano e acompanha sua saída.
4. O launcher prepara configuração, certificados, Docker, banco e servidor como hoje.
5. Ao receber código de saída zero, a interface mostra a conclusão brevemente e fecha. O navegador já terá sido aberto pelo launcher, salvo quando `-NoBrowser` estiver ativo.
6. Ao receber código diferente de zero ou não conseguir iniciar o processo, a interface muda para o estado de erro e permanece aberta.

## Tratamento de erros

Na falha, a animação para, o destaque muda para vermelho e a janela mostra uma explicação curta, o caminho `data/launcher.log` e o botão **Fechar**. A saída técnica completa não será despejada na tela. Cada execução acrescenta ao log uma linha de início, toda a saída capturada e o código de saída, sem apagar diagnósticos anteriores.

Se nem mesmo a interface WPF puder ser iniciada, o iniciador invisível grava a falha no log e usa uma caixa de mensagem nativa do Windows como último recurso.

## Atalhos e compatibilidade

- O atalho da área de trabalho passa a apontar para o iniciador invisível.
- A inicialização automática usa o mesmo iniciador com `-NoBrowser`.
- Atalhos antigos que ainda chamem o `.cmd` continuam funcionando, mas mantêm o modo textual até serem recriados pelo comando de atalhos.
- `npm start` e `Iniciar WhatsApp Central.cmd` permanecem adequados para diagnóstico e automação.

## Testes

Os testes automatizados deverão comprovar:

- existência do iniciador visual e referência ao script WPF;
- uso do iniciador invisível pelos scripts de atalho e inicialização automática;
- encaminhamento de `-NoBrowser`;
- execução oculta do launcher existente, sem duplicar a lógica de inicialização;
- mapeamento das mensagens do launcher para as quatro etapas;
- gravação de saída e erros em `data/launcher.log`;
- permanência da janela e presença do botão **Fechar** quando o processo falha;
- fechamento da janela após sucesso;
- preservação dos testes atuais do launcher.

A validação manual final abrirá o atalho em um Windows real, confirmará que não aparece console, observará a progressão visual e verificará `/health` após a abertura.

## Critérios de aceitação

- O fluxo normal mostra somente a janela visual e depois a Central.
- Nenhuma saída extensa de Docker, Node ou PowerShell aparece para o usuário.
- O progresso muda conforme as etapas reais avançam.
- Uma falha fica visível em linguagem simples e pode ser fechada pelo usuário.
- O log técnico continua disponível para diagnóstico.
- O modo automático não abre navegador.
- O launcher textual existente continua funcional.
