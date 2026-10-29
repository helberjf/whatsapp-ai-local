# Transcrição pessoal de áudios

> Execução: seguir executing-plans; interface e serviço podem ser implementados independentemente pelo contrato abaixo.

**Objetivo:** transcrever áudios da conversa por ação explícita, usando Whisper local por padrão e OpenAI opcional.

**Arquitetura:** serviço Node com fila de uma transcrição por vez, cache persistido em `data/atendimento.json` e processos FFmpeg/Python sem shell. Áudios temporários são apagados ao terminar; a chave opcional da IA fica criptografada por DPAPI em SQLite, somente no servidor. O painel continua pessoal.

**Contrato:** `GET/PATCH /api/transcription/settings` retorna configurações sem chave; `POST /api/transcriptions` recebe `{jid,messageId,provider,retry}`; `GET /api/transcriptions?jid=...` retorna trabalhos e resultados da conversa. Estados: queued, running, completed, failed. Padrões: whisper, base, pt; IA: gpt-transcribe.

- [x] Criar testes de serviço e HTTP: padrão local, validação, deduplicação concorrente, fila, cache após reinício, falha sem envio automático à IA, chave não exposta e multipart oficial. Executar antes de implementar, confirmando falha.
- [x] Implementar `lib/transcription.cjs`, `lib/audio-engines.cjs` e `scripts/transcribe.py`. Limitar entrada a 10 MB e duração a 10 minutos; interromper processos com prazo, limpar temporários e marcar trabalhos interrompidos no reinício. Aceitar somente IDs de mensagens e mídia de áudio obtida pelo conector.
- [x] Integrar rotas autenticadas em `server.cjs`; preservar sessão e serviços existentes. Configuração de transcrição fica fora do objeto público de respostas rápidas.
- [x] Adicionar controles nos áudios, resultado copiável, configuração de modelo/idioma e chave opcional. Testar padrão Whisper, persistência visual, respostas atrasadas e preservação da reprodução durante polling.
- [x] Validar teste completo, transcrição real de áudio sintético local, interface no navegador e conexão existente. Revisar código, corrigir achados e documentar uso, mantendo somente fontes no versionamento.

Referências: [Whisper](https://github.com/openai/whisper), [API de transcrição](https://developers.openai.com/api/docs/guides/speech-to-text). A pasta `video-mp3-transcript` contém conversão com FFmpeg, mas não contém um transcritor que possa ser copiado.

## Ampliação confirmada pelo usuário durante a implementação

O usuário priorizou áudios, fotos, CRM, chave criptografada e robô por palavras-chave. O texto anexado com RAG, vários provedores, documentos e reescrita de plataforma não faz parte desta entrega. A base Node/HTML/JS existente é preservada.

- [x] `lib/credentials.cjs` + `scripts/protect-secret.ps1`: SQLite com ciphertext DPAPI no escopo CurrentUser; segredo por stdin/stdout, sem argumento nem arquivo temporário. Teste real de criptografia e reabertura com o mesmo usuário Windows.
- [x] `lib/avatars.cjs` + adaptação Evolution: fotos por endpoint autenticado, cache e deduplicação; aceitar somente HTTPS de CDN WhatsApp e imagens de até 1 MB. Testes de bloqueio a URL externa e foto indisponível.
- [x] `lib/crm.cjs` + `public/features.js/css`: etapas, próximo contato, observações e histórico; aproveitar o modelo de organização do CRM de origem, sem recursos SaaS.
- [x] `lib/automation.cjs`: regras literais e simulador, desligado por padrão, leitura independente do navegador, novas mensagens individuais de texto, reserva persistente antes de envio, pausa por contato, cooldown e histórico. Sem repetição de envio incerto nem respostas a histórico antigo.
- [x] Verificar integração visual na janela atual do navegador, preservação de rascunho ao abrir o CRM e controles da transcrição; executar a suíte completa e preparar as fontes para commit.

## Evidências

73 testes da central e 18 do Milhas aprovados. Whisper base transcreveu áudio sintético em português em aproximadamente 12 segundos; um áudio real da conversa também foi transcrito pela interface. Sessão conectada reutilizada com 578 conversas e fotos reais retornadas pelo conector. CRM, editor de contato, simulador sem envio, configuração de chave e preservação de rascunho foram conferidos no navegador. Robô permanece desligado, sem regras; não foram enviados textos de teste para contatos nem áudios para a OpenAI. A opção de IA depende da chave do usuário.

Revisão independente não deixou achados importantes pendentes. Foi corrigido o desaparecimento de fotos em cache durante a atualização da lista, com regressão que usa elementos ainda não anexados ao DOM. O texto da configuração informa corretamente a necessidade de modelo Whisper instalado.
