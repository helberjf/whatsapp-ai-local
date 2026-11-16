# Envio do menu de anexos para grupos

## Objetivo

Permitir que todas as opções já disponíveis no menu `+` da conversa sejam enviadas também para grupos do WhatsApp, sem alterar o fluxo usado em conversas individuais.

## Escopo

Quando a conversa selecionada tiver um JID de grupo (`@g.us`), o menu continuará oferecendo e passará a enviar corretamente:

- fotos e vídeos;
- áudio escolhido como arquivo;
- documentos;
- figurinhas;
- localização;
- cartões de contato.

A gravação pelo botão de microfone, enquetes, encaminhamento, agendamentos e automações não fazem parte desta mudança. Um áudio escolhido no menu, inclusive com visualização única, faz parte do escopo mesmo quando o fluxo interno reutiliza a rota de voz.

## Arquitetura e fluxo

A interface continuará usando os mesmos diálogos, prévias e formulários das conversas individuais. Ela enviará o JID da conversa aberta sem criar variantes específicas para grupos.

As rotas HTTP correspondentes trocarão a validação exclusiva de contato pela validação de destinatário de conversa, que aceita contatos individuais e grupos conhecidos pelo formato do WhatsApp. O cliente do conector aplicará a mesma regra antes de chamar a Evolution API. Não será criada uma rota paralela para grupos.

O identificador de requisição estável e a reserva persistente de envio continuarão protegendo contra duplicidade. Depois da confirmação do conector, a interface fechará o diálogo aplicável e recarregará as mensagens da conversa.

## Validação e compatibilidade

As validações existentes serão preservadas:

- limite e tipo de arquivo;
- formato de mídia e figurinha;
- coordenadas válidas para localização;
- nome, telefone e campos opcionais do cartão de contato;
- JID individual ou de grupo válido;
- confirmação explícita do conector antes de considerar o envio concluído.

As citações manterão o comportamento atual de cada item: mídia e localização poderão responder à mensagem selecionada; figurinha e contato serão enviados sem citação. A busca da mensagem original passará a aceitar o JID do grupo e continuará exigindo que a mensagem citada pertença à mesma conversa. A restrição separada de responder com texto em grupos não será alterada.

## Tratamento de erros

Erros de validação continuarão aparecendo no diálogo ou editor de origem. Falhas do conector não fecharão o diálogo nem apagarão a seleção do usuário. Um identificador que não represente contato ou grupo será rejeitado antes de qualquer chamada externa.

## Testes

Os testes automatizados deverão comprovar:

1. aceitação de JID `@g.us` pelo cliente do conector para mídia, figurinha, localização e contato;
2. envio das rotas HTTP correspondentes para o grupo aberto;
3. preservação das validações de conteúdo e rejeição de JID inválido;
4. preservação do envio para conversas individuais;
5. uso do destinatário selecionado e ausência de envio duplicado na interface.

## Critério de aceite

Com um grupo aberto, o usuário consegue escolher qualquer uma das seis opções do menu `+`, preencher ou revisar o conteúdo e enviá-lo ao grupo. O item aparece no histórico após a confirmação, e tentativas inválidas ou falhas permanecem visíveis sem produzir envio para outro destinatário.
