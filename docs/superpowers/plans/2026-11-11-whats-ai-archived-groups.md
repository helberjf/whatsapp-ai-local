# Whats AI Archived Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent `Grupos arquivados` folder with an explicit hamburger menu while keeping group activity out of private unread counts.

**Architecture:** Extend the per-account `groupPresentation` state from version 1 to version 2 with an `archived` block and dedicated archive mutation. Keep ordering and menu behavior inside `public/group-order.js`; let `public/app.js` expose only the active, archived, and private filter modes. Use the authenticated account-scoped routes already used for group pinning.

**Tech Stack:** Node.js CommonJS, the existing store abstraction, browser JavaScript, CSS, Node test runner, Playwright.

---

### Task 1: Versioned group archive state

**Files:**
- Modify: `lib/group-presentation.cjs`
- Modify: `tests/group-presentation.test.cjs`

- [ ] **Step 1: Write failing service tests**

Add tests that demonstrate version migration and membership moves:

```js
test('estado v1 migra e arquivar remove fixado, persistindo primeiro nos arquivados',async()=>{
  const store=memoryStore({groupPresentation:{version:1,pinned:['111@g.us'],normal:['222@g.us']}});
  const service=createGroupPresentation({store});
  assert.deepEqual(await service.read(),{version:2,pinned:['111@g.us'],normal:['222@g.us'],archived:[]});
  assert.deepEqual(await service.setArchived('111@g.us',true),{version:2,pinned:[],normal:['222@g.us'],archived:['111@g.us']});
});

test('desarquivar volta primeiro aos normais e arquivado ausente continua preservado',async()=>{
  const service=createGroupPresentation({store:memoryStore()});
  await service.reconcile(['111@g.us','222@g.us']);
  await service.setArchived('111@g.us',true);
  await service.reconcile(['222@g.us']);
  assert.deepEqual(await service.reconcile(['111@g.us','222@g.us']),{version:2,pinned:[],normal:['222@g.us'],archived:['111@g.us']});
  assert.deepEqual(await service.setArchived('111@g.us',false),{version:2,pinned:[],normal:['111@g.us','222@g.us'],archived:[]});
});
```

Extend reorder validation to require `{pinned, normal, archived}` and reject IDs duplicated across blocks.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/group-presentation.test.cjs`

Expected: FAIL because version 2, `archived`, and `setArchived` do not exist.

- [ ] **Step 3: Implement the minimal version 2 service**

Change the state reader and mutations to this contract:

```js
function savedState(data) {
  const value=data?.groupPresentation;
  return {version:2,pinned:Array.isArray(value?.pinned)?[...value.pinned]:[],normal:Array.isArray(value?.normal)?[...value.normal]:[],archived:Array.isArray(value?.archived)?[...value.archived]:[]};
}
```

Add `setArchived(jid, archived)` that removes `jid` from every block and unshifts it into `archived` or `normal`. Make `setPinned` reject an ID currently in `archived`. Update `reconcile` to append new IDs to `normal`, omit unavailable IDs from display ordering, and retain archived IDs in stored state so a temporarily absent archived group remains archived when it returns. Update `reorder` to validate the membership of all three blocks.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/group-presentation.test.cjs`

Expected: all group presentation tests PASS.

- [ ] **Step 5: Commit the service change**

```powershell
git add -- lib/group-presentation.cjs tests/group-presentation.test.cjs
git commit -m "feat: persist archived group state"
```

### Task 2: Account-scoped archive route and complete group reconciliation

**Files:**
- Modify: `server.cjs:286-289`
- Modify: `tests/server.test.cjs`

- [ ] **Step 1: Write failing HTTP tests**

Extend the fake upstream with two group rows, then assert:

```js
const presentation=await api('/api/group-presentation');
assert.deepEqual(presentation.normal,['123@g.us','123-456@g.us']);
const archived=await api('/api/group-presentation/archive','PATCH',{jid:'123@g.us',archived:true});
assert.deepEqual(archived.archived,['123@g.us']);
assert.equal((await request('/api/group-presentation/archive','PATCH',{jid,archived:true})).status,422);
```

This also reproduces the existing defect where reconciliation calls `client.chats()` and therefore misses groups.

- [ ] **Step 2: Run the focused server test and verify RED**

Run: `node --test --test-name-pattern="apresentação de grupos" tests/server.test.cjs`

Expected: FAIL because the GET route returns no group IDs and the archive route is absent.

- [ ] **Step 3: Implement the routes**

Use the inbox source and add the dedicated mutation:

```js
if(route==='/api/group-presentation' && req.method==='GET') {
  const ids=(await client.inboxChats()).filter(chat=>chat.isGroup || groupJid(chat.jid)).map(chat=>chat.jid);
  return json(res,200,await groupPresentation.reconcile(ids));
}
if(route==='/api/group-presentation/archive' && req.method==='PATCH') {
  const input=await readBody(req);
  return json(res,200,await groupPresentation.setArchived(input.jid,input.archived));
}
```

Keep existing session-token and active-account routing unchanged.

- [ ] **Step 4: Run server and service tests**

Run: `node --test tests/group-presentation.test.cjs tests/server.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit the HTTP change**

```powershell
git add -- server.cjs tests/server.test.cjs
git commit -m "feat: expose archived group routes"
```

### Task 3: Archived folder navigation and group menu

**Files:**
- Modify: `public/index.html:139-141`
- Modify: `public/app.js:57-118, 1008`
- Modify: `public/group-order.js`
- Modify: `public/group-order.css`
- Modify: `tests/e2e/workspace.spec.cjs`

- [ ] **Step 1: Write the failing browser test**

Add a Playwright test with routed `/api/chats`, `/api/group-presentation`, `/api/group-presentation/archive`, and `/api/group-presentation/pin` responses. Assert this flow:

```js
await page.locator('#groups-row').click();
await page.getByRole('button',{name:'Opções do grupo Grupo fixado'}).click();
await page.getByRole('menuitem',{name:'Arquivar grupo'}).click();
await expect(page.locator('#group-archived-row')).toBeVisible();
await expect(page.locator('#chat-list')).not.toContainText('Grupo fixado');
await page.locator('#group-archived-row').click();
await expect(page.locator('#chat-list')).toContainText('Grupo fixado');
await page.getByRole('button',{name:'Opções do grupo Grupo fixado'}).click();
await page.getByRole('menuitem',{name:'Desarquivar grupo'}).click();
await expect(page.locator('#chat-list')).not.toContainText('Grupo fixado');
```

Also assert the browser title and `#metric-unread` stay unchanged when the archived group has unread messages, and that Escape closes the menu.

- [ ] **Step 2: Run the focused browser test and verify RED**

Run: `npx playwright test tests/e2e/workspace.spec.cjs --grep "grupos arquivados"`

Expected: FAIL because `#group-archived-row` and menu items do not exist.

- [ ] **Step 3: Add folder markup and filtering**

Add the row:

```html
<button id="group-archived-row" class="archived-row group-archived-row" type="button" hidden aria-pressed="false">
  <svg class="icon" aria-hidden="true"><use href="#i-archive"/></svg>
  <span id="group-archived-row-label">Grupos arquivados</span>
</button>
```

In `public/app.js`, make `groups` show `WhatsAppGroups.active(matching)` and `groups-archived` show `WhatsAppGroups.archived(matching)`. Render the folder row only inside group modes. The row switches between `groups` and `groups-archived`; the main groups row returns from `groups` to private conversations and from `groups-archived` to `groups`.

- [ ] **Step 4: Replace the direct pin toggle with an accessible menu**

In `public/group-order.js`, expose `active(chats)`, `archived(chats)`, and a menu-driven `wrap`. Build one menu per open row with `role="menu"`, buttons with `role="menuitem"`, `aria-haspopup="menu"`, and `aria-expanded`. Active rows offer fix/unfix and archive. Archived rows offer desarchive only. Close on outside pointer and Escape, restore focus, and use a complete state snapshot for optimistic rollback.

Use these requests:

```js
api('/group-presentation/pin','PATCH',{jid:chat.jid,pinned:willPin})
api('/group-presentation/archive','PATCH',{jid:chat.jid,archived:willArchive})
```

Reorder the correct block with `PUT /group-presentation` and `{pinned,normal,archived}`.

- [ ] **Step 5: Style the menu and folder**

Add opaque dark menu styles, visible focus, mobile-safe hit targets, and preserve the existing pinned border:

```css
.group-action-menu{position:absolute;z-index:8;right:8px;top:56px;min-width:170px;padding:5px;background:#102019;border:1px solid #315347;border-radius:9px;box-shadow:0 12px 30px #0008}
.group-action-menu[hidden]{display:none}
.group-action-menu button{display:block;width:100%;padding:9px 11px;border:0;background:transparent;color:#e7f5ef;text-align:left;border-radius:6px}
.group-action-menu button:hover,.group-action-menu button:focus-visible{background:#24503f;outline:none}
```

- [ ] **Step 6: Run the focused browser test and verify GREEN**

Run: `npx playwright test tests/e2e/workspace.spec.cjs --grep "grupos arquivados"`

Expected: PASS.

- [ ] **Step 7: Commit the interface change**

```powershell
git add -- public/index.html public/app.js public/group-order.js public/group-order.css tests/e2e/workspace.spec.cjs
git commit -m "feat: add archived groups folder"
```

### Task 4: Integrate launcher and message-recovery fixes

**Files:**
- Modify: `scripts/start-central.ps1`
- Modify: `tests/launcher.test.cjs`
- Modify: `lib/evolution.cjs`
- Modify: `tests/server.test.cjs`

- [ ] **Step 1: Preserve the already observed RED/GREEN regression tests**

Keep the launcher test that requires a unique `?iniciar=<timestamp>` URL and the server test that requires `syncFullHistory:true` for newly created instances.

- [ ] **Step 2: Run the focused tests**

Run: `node --test tests/launcher.test.cjs tests/server.test.cjs`

Expected: PASS, proving the permanent PowerShell launcher opens a fresh page and new pairings request missed history.

- [ ] **Step 3: Commit only these fixes**

```powershell
git add -- scripts/start-central.ps1 tests/launcher.test.cjs lib/evolution.cjs tests/server.test.cjs
git commit -m "fix: refresh launcher and recover message history"
```

Do not stage `public/prospection.js`; it is an unrelated pre-existing user change.

### Task 5: Full verification and main integration

**Files:**
- Verify: entire repository

- [ ] **Step 1: Run static diff checks**

Run: `git diff --check HEAD^` and `git status --short`.

Expected: no whitespace errors; only the known user-owned `public/prospection.js` remains unstaged.

- [ ] **Step 2: Run the complete Node test suite**

Run: `npm test`

Expected: all runnable tests PASS; existing explicitly skipped tests remain skipped.

- [ ] **Step 3: Run the workspace Playwright suite**

Run: `npx playwright test tests/e2e/workspace.spec.cjs`

Expected: all workspace tests PASS.

- [ ] **Step 4: Verify the real launcher**

Run: `cmd.exe /d /c call "C:\Users\default.LAPTOP-K8F2QHAF\projects\whatsapp-central\Iniciar WhatsApp Central.cmd" --no-browser`.

Expected: exit code 0 and `/health` reports `service: whatsapp-local`.

- [ ] **Step 5: Push commits to main without staging the user file**

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
```

Expected: fast-forward push to `origin/main`. Confirm `public/prospection.js` remains modified locally and uncommitted.
