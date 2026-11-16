# Group Attachment Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir o envio de todas as opções do menu `+` para grupos do WhatsApp com as mesmas validações e proteções contra duplicidade usadas em conversas individuais.

**Architecture:** A interface deixará de descartar anexos quando o chat selecionado for um grupo. As rotas e o cliente Evolution usarão `assertConversationJid` nos fluxos de mídia, figurinha, áudio escolhido, localização e contato, mantendo `assertJid` nas funções exclusivas de contatos. A confirmação de grupo verificará o JID retornado pelo conector para impedir sucesso atribuído ao destinatário errado.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, JavaScript no navegador, Evolution API.

---

### Task 1: Aceitar anexos de grupo no cliente Evolution

**Files:**
- Modify: `tests/whatsapp-features.test.cjs`
- Modify: `lib/evolution.cjs`

- [ ] **Step 1: Write the failing connector test**

Adicionar um teste que usa `group = '123-456@g.us'`, prepara respostas para `/sendMedia/`, `/sendSticker/`, `/sendLocation/`, `/sendContact/` e `/sendViewOnce/`, chama `sendMedia`, `sendSticker`, `sendLocation`, `sendContact` e `sendVoice` com esse grupo e verifica `calls.at(-1).input.number === group`. Incluir uma mídia citada cuja mensagem original tenha `remoteJid: group` e confirmar que a chave citada pertence ao grupo. Confirmar também que `status@broadcast` continua rejeitado com status 422.

- [ ] **Step 2: Run the connector test to verify RED**

Run: `node --test --test-name-pattern="conector envia opções do menu para grupos" tests/whatsapp-features.test.cjs`

Expected: FAIL com `Destinatário inválido` porque `sendMedia`, `sendSticker`, `sendLocation`, `sendContact`, `sendVoice` e `rawMessage` usam `assertJid`.

- [ ] **Step 3: Implement conversation-JID validation**

Em `lib/evolution.cjs`, mudar somente os fluxos usados pelo menu:

```js
async function rawMessage(jid,id) {
  assertConversationJid(jid);
  // validação de id e busca existentes permanecem iguais
}
```

Usar `const target=assertConversationJid(jid)` em `sendMedia`, `sendVoice`, `sendLocation`, `sendContact` e `sendSticker`; passar `target` a `quotedFor` e no campo `number`. Após cada resposta, exigir que grupos sejam confirmados com `result.key.remoteJid===target` e `result.key.fromMe===true`, reutilizando um helper local de confirmação quando isso evitar duplicação. Não alterar presença, edição, bloqueio, encaminhamento, enquetes ou automações.

- [ ] **Step 4: Run the connector test to verify GREEN**

Run: `node --test --test-name-pattern="conector envia opções do menu para grupos" tests/whatsapp-features.test.cjs`

Expected: PASS.

- [ ] **Step 5: Run the complete connector feature tests**

Run: `node --test tests/whatsapp-features.test.cjs`

Expected: todos os testes passam sem avisos.

### Task 2: Aceitar grupos nas rotas HTTP do menu

**Files:**
- Modify: `tests/whatsapp-features.test.cjs`
- Modify: `server.cjs`
- Modify: `lib/messaging-routes.cjs`

- [ ] **Step 1: Write the failing route test**

Adicionar um teste de servidor com `group = '123-456@g.us'` que faça POST em:

```js
await call('/api/send-media','POST',{jid:group,mediaType:'document',base64:'aGVsbG8=',fileName:'arquivo.txt',mimeType:'text/plain',requestId:'group-media'});
await call('/api/send-sticker','POST',{jid:group,base64:'aGVsbG8=',requestId:'group-sticker'});
await call('/api/send-location','POST',{jid:group,latitude:-23.5,longitude:-46.6,requestId:'group-location'});
await call('/api/send-contact','POST',{jid:group,fullName:'Carla',phone:'11988887777',requestId:'group-contact'});
await call('/api/send-voice','POST',{jid:group,base64:'T2dnUw==',mimeType:'audio/ogg',viewOnce:true,requestId:'group-audio-once'});
```

O roteiro falso deve responder com uma chave `remoteJid: group`, e o teste deve verificar status 200, uma chamada externa por `requestId` e status 422 para `jid: 'status@broadcast'`.

- [ ] **Step 2: Run the route test to verify RED**

Run: `node --test --test-name-pattern="rotas enviam opções do menu para grupos" tests/whatsapp-features.test.cjs`

Expected: FAIL com status 422 nas rotas que ainda chamam `assertJid`.

- [ ] **Step 3: Implement route validation**

Em `server.cjs`, trocar para `assertConversationJid` nas rotas `/api/send-media` e `/api/send-sticker`. Em `lib/messaging-routes.cjs`, importar `assertConversationJid` e usá-lo em `/api/send-location`, `/api/send-contact` e `/api/send-voice`; manter `/api/voice/transcribe-draft` com `assertJid`, pois transcrição local não é um envio para grupo.

- [ ] **Step 4: Run the route test to verify GREEN**

Run: `node --test --test-name-pattern="rotas enviam opções do menu para grupos" tests/whatsapp-features.test.cjs`

Expected: PASS e exatamente uma chamada do conector por pedido repetido.

- [ ] **Step 5: Run backend regression tests**

Run: `node --test tests/whatsapp-features.test.cjs tests/server.test.cjs`

Expected: todos os testes passam.

### Task 3: Permitir seleção e envio de anexos no grupo aberto

**Files:**
- Modify: `tests/frontend.test.cjs`
- Modify: `public/app.js`

- [ ] **Step 1: Write the failing browser test**

Criar um navegador com uma única conversa de grupo:

```js
const group='123-456@g.us';
const browser=await createBrowser({
  withMedia:true,
  FileReader:class {readAsDataURL(){this.result='data:image/png;base64,aGVsbG8=';this.onload();}},
  chatRecords:[{jid:group,name:'Grupo da família',isGroup:true,unread:0,status:'open',labels:[]}]
});
browser.get('attachment').files=[new File(['hello'],'foto.png',{type:'image/png'})];
await browser.get('attachment').emit('change');
assert.equal(browser.get('attachment-info').hidden,false);
await browser.get('composer').emit('submit');
assert.equal(browser.requests.find(request=>request.path==='/api/send-media').input.jid,group);
```

Adicionar uma asserção separada de que `attach-contact` e `attach-location` continuam abrindo seus diálogos no grupo; esses envios usam as rotas cobertas na Task 2.

- [ ] **Step 2: Run the browser test to verify RED**

Run: `node --test --test-name-pattern="menu de anexos funciona no grupo aberto" tests/frontend.test.cjs`

Expected: FAIL porque `setAttachment` retorna imediatamente quando `selected.isGroup` é verdadeiro.

- [ ] **Step 3: Remove the group-only UI guard**

Em `public/app.js`, manter a trava `if(sending) return;` e remover apenas:

```js
if(selected?.isGroup) return;
```

Não habilitar gravação pelo microfone: `canRecord` deve continuar exigindo `!selected.isGroup`.

- [ ] **Step 4: Run the browser test to verify GREEN**

Run: `node --test --test-name-pattern="menu de anexos funciona no grupo aberto" tests/frontend.test.cjs`

Expected: PASS.

- [ ] **Step 5: Run frontend regression tests**

Run: `node --test tests/frontend.test.cjs`

Expected: todos os testes passam.

### Task 4: Verify the complete feature

**Files:**
- Verify: `README.md`
- Verify: all modified production and test files

- [ ] **Step 1: Update the documented behavior**

Na seção Messaging do `README.md`, acrescentar que as opções do menu de anexos podem ser enviadas em conversas individuais e grupos, enquanto a gravação pelo microfone continua exclusiva de conversas individuais.

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/whatsapp-features.test.cjs tests/server.test.cjs tests/frontend.test.cjs`

Expected: todos os testes passam.

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`

Expected: exit code 0, sem falhas.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: nenhuma falha de whitespace; somente os arquivos desta funcionalidade, o plano e alterações preexistentes do usuário aparecem no status.

- [ ] **Step 5: Commit only the feature files**

```powershell
git add -- lib/evolution.cjs lib/messaging-routes.cjs server.cjs public/app.js README.md tests/whatsapp-features.test.cjs tests/frontend.test.cjs
git commit -m "feat: send attachments to WhatsApp groups"
```

Não adicionar `public/prospection.js` nem `scripts/start-central.ps1` ao commit.
