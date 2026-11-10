# Whats AI: abertura direta, identidade visual e PWA

## Objetivo

Ao abrir o Whats AI pelo iniciador principal, preparar os serviços locais e mostrar a central diretamente no navegador. A mesma central também deve poder ser instalada como PWA, com identidade visual própria e consistente no navegador, no Windows e na interface.

## Experiência de abertura

- `Iniciar WhatsApp Central.cmd` continua sendo o iniciador canônico.
- Se a central já estiver pronta, o iniciador abre imediatamente `http://127.0.0.1:8766/` no navegador padrão.
- Se a central precisar iniciar, o navegador abre quando a verificação de saúde confirmar que ela está pronta.
- A inicialização automática do Windows continua sem abrir uma janela do navegador.
- Falhas permanecem visíveis no terminal do iniciador, com orientação objetiva para correção.

## PWA

A página incluirá um manifesto web com nome `Whats AI`, nome curto, cor do tema, cor de fundo, orientação, `start_url` e modo `standalone`. Serão fornecidos ícones normais e `maskable` nos tamanhos necessários para navegador, instalação e atalhos.

Um service worker cuidará somente da experiência de carregamento da interface. Requisições de API, conversas, mídias e demais dados privados nunca serão gravados no cache. Para evitar uma interface antiga sobre um servidor atualizado, os arquivos da aplicação usarão atualização controlada e a navegação priorizará a rede. Quando o servidor local estiver indisponível, uma página de contingência explicará como iniciar a central.

## Identidade visual

O símbolo será original: um balão de conversa verde, com traços simples e a sigla `AI` integrada. Ele será inspirado na familiaridade visual de aplicativos de mensagem, sem reproduzir o telefone, o desenho ou as proporções do logotipo oficial do WhatsApp.

A identidade será aplicada a:

- marca no menu lateral;
- favicon e metadados do navegador;
- ícones do manifesto PWA;
- ícone do atalho criado no Windows;
- tela de contingência do service worker.

O restante da interface manterá a linguagem visual escura atual. As alterações serão pontuais para não interferir nos fluxos de atendimento existentes.

## Limpeza dos iniciadores `.cmd`

Os iniciadores antigos e duplicados que hoje dependem do fluxo quebrado serão removidos:

- `Abrir WhatsApp.cmd`;
- `Iniciar WhatsApp.cmd`;
- `Parar WhatsApp.cmd`.

Serão preservados os iniciadores canônicos `Iniciar WhatsApp Central.cmd` e `Parar WhatsApp Central.cmd`. Os comandos para criar o atalho e controlar a inicialização com o Windows serão mantidos, mas passarão a apontar para o iniciador canônico e a usar a nova identidade visual. Nenhum `.cmd` será removido apenas por parecer antigo: seu destino e sua função serão verificados antes da exclusão.

## Componentes e limites

- O launcher é responsável apenas por preparar serviços, aguardar saúde e abrir a URL.
- O servidor entrega o manifesto, o service worker, a contingência e os arquivos de identidade como recursos estáticos com os tipos corretos.
- A página registra o service worker e expõe os metadados do PWA.
- As rotas `/api/`, `/health` e recursos de mensagens ou mídias ficam explicitamente fora do armazenamento offline.

## Verificação

Os testes automatizados devem comprovar:

- manifesto e metadados PWA presentes e válidos;
- recursos de ícone entregues com dimensões e tipos esperados;
- service worker sem cache de API ou dados privados;
- iniciador canônico abrindo a URL quando permitido e respeitando `-NoBrowser`;
- scripts de atalho e inicialização apontando para um destino existente;
- ausência dos aliases `.cmd` removidos;
- interface carregando normalmente em testes de navegador, nos modos comum e instalado.

Também será feita inspeção visual do ícone, do cabeçalho e da aparência standalone em larguras de desktop e celular.

## Fora de escopo

- funcionamento completo das conversas sem o servidor local;
- publicação em lojas de aplicativos;
- alteração ampla do layout da central;
- cópia do logotipo ou de ativos oficiais do WhatsApp.
