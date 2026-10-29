# Agendamento, contatos e conversa

**Objetivo:** programar mensagens pessoais, carregar nomes disponíveis no WhatsApp, melhorar o áudio, compactar os indicadores e oferecer encaminhamento/cópia pelo menu de cada mensagem.

**Execução:** aplicar executing-plans com testes de comportamento antes de implementar. Trabalho dividido por arquivos independentes: serviço/rotas/agendamento; resolução de contatos no adaptador; interface de áudio, métricas e encaminhamento. Manter Node/HTML/JS e a sessão existente.

**Decisões:** agendar texto para um contato e data/hora locais, persistindo instante ISO em disco. O worker funciona com navegador fechado; computador e conector precisam estar ligados. Até 15 minutos de atraso por indisponibilidade, aguarda conexão; depois registra não enviado e permite remarcar. Reservar envio antes de chamar o WhatsApp; envios incertos nunca são repetidos automaticamente. Cancelar/editar somente antes do envio; preservar rascunhos novos durante respostas assíncronas.

**Contratos:** GET/POST `/api/scheduled-messages`; PATCH `/api/scheduled-messages/:id` com texto/data; POST `/api/scheduled-messages/:id/cancel`. POST `/api/contacts/sync` atualiza cache de nomes; GET chats aplica mapeamentos explícitos do conector. POST `/api/forward` recebe somente `{sourceJid,messageId,targetJid,requestId}`, lê a mensagem original no servidor e usa deduplicação existente. Copiar usa clipboard local e texto seguro.

- [x] Criar testes de agendamento: validação, fuso, persistência, alteração/cancelamento, concorrência, reinício, desconexão/atraso e envio incerto sem repetição. Integrar worker ao início/parada do servidor.
- [x] Criar diálogo de agenda com lista real, filtros, criação, edição e cancelamento; acesso pelo menu e conversa. Mostrar destino/data/texto antes de programar.
- [x] Consultar dados reais e contrato Evolution 2.3.7 para nomes; priorizar nomes disponíveis sem inventar correspondências entre telefone e identificador privado. Cache e botão de atualização.
- [x] Melhorar card/player de áudio, preservando reprodução e transcrição durante atualização. Reduzir altura dos quatro indicadores solicitados.
- [x] Adicionar seta por mensagem, cópia de texto e diálogo de encaminhamento com confirmação e destino explícitos; testar texto/anexos sem enviar mensagens reais.
- [x] Revisão independente, suíte completa, verificação visual e documentação; preparar fontes para commit, preservando preferências, rascunhos, chaves criptografadas e volumes Docker.

## Verificação

124 testes da central e 18 do Milhas aprovados. Navegador confirmou indicadores de 56 px, sessão conectada com 579 conversas, atualização real de nomes (4.255 contatos nomeados entre 4.330 contatos individuais do conector), card de áudio com duração real de 10 segundos e velocidade 1,5× preservada durante atualização, seta de opções, destinatário confirmado no diálogo e agenda com formulário pela conversa. Não foram criadas programações nem enviados encaminhamentos para contatos reais durante os testes.

Revisão independente corrigida: tipos especiais não podem virar texto substituto ao encaminhar; trocar destino A→B→A mantém o identificador de um envio incerto; falhas somente na leitura da origem permitem tentar novamente antes da reserva de envio. Testes locais verificam que falha após início mantém a reserva, inclusive após reinício.

Limitação do conector: `pushName` mistura nome de perfil e nome da agenda; `isSaved` não comprova origem. Nomes sem correspondência explícita permanecem numéricos. A Evolution 2.3.7 não expõe selo nativo de encaminhamento; a central envia o conteúdo original como nova mensagem.
