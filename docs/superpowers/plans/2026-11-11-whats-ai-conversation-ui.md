# Whats AI Conversation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unread indicators, dashboard cards, contact media, group organization, transcription timing, and dark-theme selects behave like the approved WhatsApp-style design.

**Architecture:** Keep the current server and workspace intact, adding two bounded services: per-account group presentation and paginated conversation media. Add focused browser modules for group ordering and contact media, while `public/app.js` remains the coordinator for chat selection, unread totals, and message actions. Reuse the existing authenticated API helper, per-account store, transcription deduplication, avatar loader, and protected media viewer.

**Tech Stack:** Node.js 22 CommonJS, native HTTP server, PostgreSQL-backed application store, vanilla JavaScript/CSS, Node test runner, Playwright.

---

## File structure

- Create `lib/group-presentation.cjs`: validate and persist pinned/normal group order for one account.
- Create `public/group-order.js`: load preferences, arrange group rows, manage hamburger actions, drag/drop, optimistic rollback.
- Create `public/group-order.css`: pinned boundary, drag affordance, menu, and drop-state styles.
- Create `public/contact-media.js`: profile-photo viewer, contact side-panel preview, full paginated gallery, stale-request cancellation.
- Create `public/contact-media.css`: contact preview and responsive gallery styles.
- Create `tests/group-presentation.test.cjs`: service and HTTP contract tests for per-account group preferences.
- Create `tests/contact-media.test.cjs`: connector/server media filtering and pagination tests.
- Modify `server.cjs`: register new assets/routes, instantiate group presentation per account, remove background audio scanning, add explicit five-audio discovery.
- Modify `lib/evolution.cjs`: query recent audio and paginated image/video records safely.
- Modify `public/index.html`: remove conversation totals/card; split avatar/name actions; add media preview and gallery dialog; load new assets.
- Modify `public/app.js`: unread document title, compact counters, new modules, group row decoration, manual audio action.
- Modify `public/avatars.js`: expose a cached profile-photo loader without duplicating requests.
- Modify `public/app.css` and `public/messaging.css`: compact metrics, opaque selects/options, header targets, mobile layout.
- Modify `tests/frontend.test.cjs`, `tests/server.test.cjs`, `tests/transcription-http.test.cjs`, and `tests/e2e/workspace.spec.cjs`: regression and browser coverage.

### Task 1: Unread title, removed totals, compact cards, and readable selects

**Files:**
- Modify: `tests/frontend.test.cjs`
- Modify: `tests/e2e/workspace.spec.cjs`
- Modify: `public/index.html:120-145`
- Modify: `public/app.js:58-66, 929-1003`
- Modify: `public/app.css:2-7`
- Modify: `public/messaging.css:16-19, 76-78`

- [ ] **Step 1: Write failing frontend tests for title and removed totals**

Extend the fake document in `tests/frontend.test.cjs` with `title:'Whats AI'`, provide two chats with unread values `2` and `3`, and assert:

```js
test('browser title reports unread messages and conversation totals stay hidden',async()=>{
  const browser=await createBrowser({chatRecords:[
    {jid,name:'Ana',unread:2,status:'open',labels:[],notes:[],lastMessage:message(2)},
    {jid:'5511888888888@s.whatsapp.net',name:'Bia',unread:3,status:'open',labels:[],notes:[],lastMessage:{...message(3),jid:'5511888888888@s.whatsapp.net'}}
  ]});
  assert.equal(browser.document.title,'(5) Whats AI');
  assert.equal(browser.get('filter-total-count').textContent,'');
  assert.equal(browser.get('chat-count').textContent,'');
  browser.setUnread(0);
  assert.equal(browser.document.title,'Whats AI');
});
```

Return `document` and a small `setUnread()` helper from the fixture so the zero transition is testable through the same render path.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
node --test tests/frontend.test.cjs --test-name-pattern "browser title reports unread"
```

Expected: FAIL because the title is not updated and total-count elements still receive values.

- [ ] **Step 3: Implement unread-title calculation and remove total bindings**

In `public/app.js`, calculate unread messages from non-group, non-archived chats and use one updater:

```js
function updateUnreadTitle(active) {
  const unread=active.reduce((sum,chat)=>sum+Math.max(0,Number(chat.unread)||0),0);
  document.title=unread?`(${unread}) Whats AI`:'Whats AI';
}
```

Call it from `renderChats()`. Stop writing `active.length` to `metric-total`, `filter-total-count`, `nav-chat-count`, and `chat-count`. Remove the `metric-total-button` card and the count spans beside `Todas` and the inbox heading from `public/index.html`. Remove its click listener from `public/app.js`. In `renderDashboard()`, remove the `Conversas` tuple so the dashboard does not recreate the same total.

- [ ] **Step 4: Make remaining metric cards compact and options opaque**

Replace the metric content layout with inline value/label rules:

```css
.metrics{grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
.metric-card{height:48px;padding:7px 10px;gap:8px;border-radius:10px}
.metric-card>span:nth-child(2){display:flex;align-items:baseline;gap:6px}
.metric-card strong{display:inline;font-size:18px;line-height:1}
.metric-card small{display:inline;margin:0;font-size:10px}
.metric-icon{width:28px;height:28px;border-radius:8px}
select{color:#e3efed;background-color:#15252c;color-scheme:dark}
select option{color:#e3efed;background:#15252c}
select option:checked{color:#fff;background:#176b56}
```

Keep the existing icon color classes and add a narrow-screen grid rule instead of shrinking text below 10px.

- [ ] **Step 5: Add Playwright assertions for layout and dropdown contrast**

In `tests/e2e/workspace.spec.cjs`, assert that `#metric-total-button`, `#filter-total-count`, and `#chat-count` do not exist; verify remaining card value/label bounding boxes share a vertical center; verify computed `backgroundColor` and `color` for `#quick-template` are opaque and distinct.

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
node --test tests/frontend.test.cjs
npx playwright test tests/e2e/workspace.spec.cjs --grep "unread title|compact metrics|opaque selects"
```

Expected: all selected tests pass.

Commit:

```powershell
git add public/index.html public/app.js public/app.css public/messaging.css tests/frontend.test.cjs tests/e2e/workspace.spec.cjs
git commit -m "feat: compact conversation indicators"
```

### Task 2: Persist group pinning and manual order per account

**Files:**
- Create: `lib/group-presentation.cjs`
- Create: `tests/group-presentation.test.cjs`
- Modify: `server.cjs:124-199, 264-305`

- [ ] **Step 1: Write failing service tests**

Create `tests/group-presentation.test.cjs` with an in-memory store and these cases:

```js
test('last fixed group enters first and order survives reload',async()=>{
  const store=memoryStore();
  const first=createGroupPresentation({store});
  await first.setPinned('111@g.us',true);
  await first.setPinned('222@g.us',true);
  assert.deepEqual(await first.read(),{version:1,pinned:['222@g.us','111@g.us'],normal:[]});
  assert.deepEqual(await createGroupPresentation({store}).read(),{version:1,pinned:['222@g.us','111@g.us'],normal:[]});
});

test('reorder cannot cross the pinned boundary or duplicate groups',async()=>{
  const service=createGroupPresentation({store:memoryStore()});
  await service.setPinned('111@g.us',true);
  await assert.rejects(service.reorder({pinned:[],normal:['111@g.us']}),error=>error.status===409);
  await assert.rejects(service.reorder({pinned:['111@g.us'],normal:['222@g.us','222@g.us']}),error=>error.status===422);
});
```

Also test non-group JIDs, arrays over 5,000 items, unknown keys, unfix insertion at the start of `normal`, and independent stores for two accounts.

- [ ] **Step 2: Run the new test and confirm failure**

Run:

```powershell
node --test tests/group-presentation.test.cjs
```

Expected: FAIL because `lib/group-presentation.cjs` does not exist.

- [ ] **Step 3: Implement the bounded group-presentation service**

Create a service with this public interface:

```js
const {ApiError,groupJid}=require('./evolution.cjs');
const MAX_GROUPS=5000;
const clean=list=>{
  if(!Array.isArray(list) || list.length>MAX_GROUPS || list.some(jid=>!groupJid(jid)) || new Set(list).size!==list.length)
    throw new ApiError('Ordem de grupos inválida.',422);
  return [...list];
};
function createGroupPresentation({store}) {
  const state=data=>({version:1,pinned:[...(data.groupPresentation?.pinned||[])],normal:[...(data.groupPresentation?.normal||[])]});
  return {
    read:async()=>state(await store.read()),
    reconcile:ids=>store.update(data=>{
      const known=clean(ids),current=state(data),present=new Set(known);
      const pinned=current.pinned.filter(jid=>present.has(jid));
      const normal=current.normal.filter(jid=>present.has(jid));
      const ordered=new Set([...pinned,...normal]);
      normal.push(...known.filter(jid=>!ordered.has(jid)));
      data.groupPresentation={version:1,pinned,normal};return state(data);
    }),
    reorder:input=>store.update(data=>{
      const previous=state(data),pinned=clean(input.pinned),normal=clean(input.normal);
      if(Object.keys(input).some(key=>!['pinned','normal'].includes(key)) || pinned.some(jid=>normal.includes(jid))) throw new ApiError('Ordem de grupos inválida.',422);
      if(previous.pinned.some(jid=>!pinned.includes(jid)) || pinned.some(jid=>!previous.pinned.includes(jid))) throw new ApiError('Use Fixar ou Desafixar para mudar o bloco.',409);
      if([...previous.pinned,...previous.normal].sort().join('\n')!==[...pinned,...normal].sort().join('\n')) throw new ApiError('Atualize a lista de grupos e tente novamente.',409);
      data.groupPresentation={version:1,pinned,normal};return state(data);
    }),
    setPinned:(jid,pinned)=>store.update(data=>{
      if(!groupJid(jid) || typeof pinned!=='boolean') throw new ApiError('Grupo inválido.',422);
      const current=state(data);current.pinned=current.pinned.filter(id=>id!==jid);current.normal=current.normal.filter(id=>id!==jid);
      (pinned?current.pinned:current.normal).unshift(jid);data.groupPresentation=current;return current;
    })
  };
}
module.exports={createGroupPresentation};
```

- [ ] **Step 4: Add authenticated per-account HTTP routes**

Instantiate `groupPresentation=createGroupPresentation({store})` inside `createAccountRuntime()` and return it with the runtime. Add:

```js
if(route==='/api/group-presentation' && req.method==='GET')
  return json(res,200,await groupPresentation.reconcile((await client.chats()).filter(chat=>chat.isGroup).map(chat=>chat.jid)));
if(route==='/api/group-presentation' && req.method==='PUT')
  return json(res,200,await groupPresentation.reorder(await readBody(req)));
if(route==='/api/group-presentation/pin' && req.method==='PATCH') {
  const input=await readBody(req);
  return json(res,200,await groupPresentation.setPinned(input.jid,input.pinned));
}
```

Ensure the runtime destructuring includes `groupPresentation`, so account selection automatically isolates the data.

- [ ] **Step 5: Add HTTP isolation and validation tests**

Use the existing multi-account harness pattern in `tests/accounts.test.cjs` or the new test file. Send `X-WhatsApp-Account` for two accounts, pin different groups, reload both, and assert no state crosses accounts.

- [ ] **Step 6: Run and commit**

Run:

```powershell
node --test tests/group-presentation.test.cjs tests/accounts.test.cjs
```

Expected: all tests pass.

Commit:

```powershell
git add lib/group-presentation.cjs server.cjs tests/group-presentation.test.cjs tests/accounts.test.cjs
git commit -m "feat: persist manual group ordering"
```

### Task 3: Add group drag/drop and hamburger pin menu

**Files:**
- Create: `public/group-order.js`
- Create: `public/group-order.css`
- Modify: `public/index.html`
- Modify: `public/app.js:58-145, 1090-1115`
- Modify: `server.cjs:222-250`
- Modify: `tests/frontend.test.cjs`
- Modify: `tests/e2e/workspace.spec.cjs`

- [ ] **Step 1: Write a failing browser test for pin order and persistence**

Add a Playwright test that fulfills group-presentation routes with mutable state, opens `Grupos`, pins the second row from its hamburger menu, and asserts it becomes first. Drag the last normal row above the first normal row, reload, and assert both blocks retain their order. Also force one PUT to return 500 and assert the UI rolls back.

- [ ] **Step 2: Run the Playwright test and confirm failure**

Run:

```powershell
npx playwright test tests/e2e/workspace.spec.cjs --grep "groups can be pinned and dragged"
```

Expected: FAIL because the menu and drag behavior do not exist.

- [ ] **Step 3: Implement the focused browser module**

Implement internal `init`, `arrange`, `wrap`, and `refresh` functions and export only this bounded surface:

```js
window.WhatsAppGroups={init,arrange,wrap,refresh};
```

`init` stores the supplied `api`, `notice`, and `render` functions and loads GET `/group-presentation`. `arrange` maps IDs from `state.pinned` followed by `state.normal`, then appends unknown groups in their existing order. `wrap` returns a draggable group-row wrapper with a hamburger button and the pin/unpin action. `refresh` repeats the authenticated GET after an account change. The module must snapshot state before optimistic pin/reorder, issue PATCH/PUT, call `render()`, and restore the snapshot plus `notice(error.message)` on failure. Use native drag events only on group rows. Reject drops between pinned and normal blocks with an accessible notice; pin state changes only through the hamburger action. Close the menu after an action and label it with the group name.

- [ ] **Step 4: Integrate without breaking virtualized chat rows**

In `renderChats()`, use `WhatsAppGroups.arrange(matching)` only when `listFilter==='groups'`; retain existing ordering elsewhere. In `chatButton()`, build the existing button first, then pass it to `WhatsAppGroups.wrap(button,chat)` only for group-filter rows. The wrapper must retain `.chat-item` as the measurable child, so virtual row-height measurement still works.

Add `/assets/group-order.js` and `/assets/group-order.css` to the exact server asset allowlist and load them from `public/index.html` before `app.js` initialization.

- [ ] **Step 5: Add compact and accessible CSS**

Use a 76px row wrapper, an absolute 28px hamburger target, visible pinned divider, `cursor:grab`, `.dragging` opacity, and `.drop-before` outline. At mobile widths, retain a minimum 36px pointer target without covering the unread badge.

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
node --test tests/frontend.test.cjs tests/group-presentation.test.cjs
npx playwright test tests/e2e/workspace.spec.cjs --grep "groups can be pinned and dragged|grupos ficam"
```

Expected: all selected tests pass.

Commit:

```powershell
git add public/group-order.js public/group-order.css public/index.html public/app.js server.cjs tests/frontend.test.cjs tests/e2e/workspace.spec.cjs
git commit -m "feat: organize groups by drag and pin"
```

### Task 4: Transcribe only the five latest private audios on open

**Files:**
- Modify: `lib/evolution.cjs:451-468`
- Modify: `server.cjs:164-180, 299-303, 352-358`
- Modify: `public/app.js:347-380, 701-740`
- Modify: `tests/transcription-http.test.cjs`
- Modify: `tests/frontend.test.cjs`
- Modify: `tests/e2e/workspace.spec.cjs`

- [ ] **Step 1: Write failing server tests for the five-audio boundary**

Add a harness where `client.recentAudioMessages(jid,5)` returns seven audio records. Call the new discovery endpoint and assert only the five newest IDs reach `transcriptions.discover`. Assert group JIDs receive 422 and repeat calls return the existing jobs rather than duplicates.

```js
test('opening a private chat discovers only its five latest audios',async()=>{
  const response=await api('/api/transcriptions/discover','POST',{jid});
  assert.equal(response.status,200);
  assert.deepEqual(discovered.map(item=>item.id),['audio-3','audio-4','audio-5','audio-6','audio-7']);
  assert.equal((await api('/api/transcriptions/discover','POST',{jid:'123@g.us'})).status,422);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
node --test tests/transcription-http.test.cjs --test-name-pattern "five latest audios"
```

Expected: FAIL because the endpoint and connector query do not exist.

- [ ] **Step 3: Add a connector method that asks only for audio records**

Implement `recentAudioMessages(jid,limit=5)` in `lib/evolution.cjs`. Validate with `assertJid`, query both safe aliases using `/chat/findMessages/:instance` with `where.key.remoteJid` and `messageType:'audioMessage'`, request a bounded page, normalize/deduplicate, sort by timestamp, and return `.slice(-limit)`. Do not download media bytes.

- [ ] **Step 4: Replace background discovery with an explicit open action**

Delete `audioCursors`, `audioStartedAt`, `pollAudio()`, and its call from `pollReplies()`. Add:

```js
if(req.method==='POST' && route==='/api/transcriptions/discover') {
  const input=await readBody(req),jid=assertJid(input.jid);
  const audios=await client.recentAudioMessages(jid,5);
  await transcriptions.discover(jid,audios);
  return json(res,200,{discovered:audios.length});
}
```

`assertJid` deliberately rejects groups. Keep `transcriptions.discover` deduplication unchanged.

- [ ] **Step 5: Trigger discovery once per private chat selection**

At the end of successful `selectChat(chat)`, call `/transcriptions/discover` only when `!chat.isGroup`. Do not block message rendering on it; refresh transcription state after success and show only actionable errors. A repeated selection may call again because server-side deduplication is authoritative.

- [ ] **Step 6: Make manual transcription available for old private audio and all group audio**

Replace the current non-group-only `Priorizar transcrição` condition with a `Transcrever áudio` action for every valid audio. The click handler posts `{jid,messageId,provider:'whisper',retry:true}`. If a queued/running job already exists, retain the priority action; if completed, report that it is already transcribed. This gives older private audio and group audio the required on-demand path.

- [ ] **Step 7: Run focused tests and commit**

Run:

```powershell
node --test tests/transcription-http.test.cjs tests/frontend.test.cjs tests/voice-flow.test.cjs
npx playwright test tests/e2e/workspace.spec.cjs --grep "five latest audios|group audio transcribes only on request|priority waits"
```

Expected: all selected tests pass.

Commit:

```powershell
git add lib/evolution.cjs server.cjs public/app.js tests/transcription-http.test.cjs tests/frontend.test.cjs tests/e2e/workspace.spec.cjs
git commit -m "feat: transcribe recent private audio on open"
```

### Task 5: Add safe paginated conversation-media data

**Files:**
- Create: `tests/contact-media.test.cjs`
- Modify: `lib/evolution.cjs:451-468`
- Modify: `server.cjs:278-305`

- [ ] **Step 1: Write failing connector and HTTP tests**

Test that the connector sends a bounded `findMessages` query for `imageMessage` and `videoMessage`, merges aliases, removes duplicates, preserves timestamp order, and returns no media bytes. Test `/api/conversation-media?jid=5511998765432%40s.whatsapp.net&page=1` with valid session headers, invalid JID, group JID, and page outside `1..10000`.

```js
assert.deepEqual(result.items.map(item=>item.type),['image','video']);
assert.equal(JSON.stringify(result).includes('base64'),false);
assert.deepEqual(Object.keys(result),['items','page','pages','total']);
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
node --test tests/contact-media.test.cjs
```

Expected: FAIL because `conversationMedia()` and the HTTP route do not exist.

- [ ] **Step 3: Implement `client.conversationMedia(jid,page)`**

Follow the alias-safe structure of `messages()`, but query only `messageType:{in:['imageMessage','videoMessage']}` with `offset:30`. Normalize records, retain only `image`/`video`, omit `key`, thumbnails larger than the existing safe preview, and any connector-only fields, then return:

```js
{items,page:currentPage,pages,total}
```

Each item contains only `id`, `jid`, `fromMe`, `type`, `timestamp`, `text`, `mimeType`, `fileName`, `durationSeconds`, and the already bounded `jpegThumbnail` when available.

- [ ] **Step 4: Add the authenticated API route**

Add GET `/api/conversation-media`. Validate with `assertJid` so groups do not enter the contact-only panel, validate page as an integer from 1 to 10,000, and return the connector result. Leave byte loading exclusively on existing `/api/media`.

- [ ] **Step 5: Run and commit**

Run:

```powershell
node --test tests/contact-media.test.cjs tests/message-actions.test.cjs tests/server.test.cjs
```

Expected: all tests pass.

Commit:

```powershell
git add lib/evolution.cjs server.cjs tests/contact-media.test.cjs tests/message-actions.test.cjs tests/server.test.cjs
git commit -m "feat: expose safe contact media pages"
```

### Task 6: Open profile photos and contact media like WhatsApp

**Files:**
- Create: `public/contact-media.js`
- Create: `public/contact-media.css`
- Modify: `public/avatars.js`
- Modify: `public/index.html`
- Modify: `public/app.js:390-407, 690-716, 1090-1115`
- Modify: `server.cjs:222-250`
- Modify: `tests/frontend.test.cjs`
- Modify: `tests/e2e/workspace.spec.cjs`

- [ ] **Step 1: Write failing frontend tests for separate click targets**

Extend the browser fixture with `/api/conversation-media` and avatar responses. Assert avatar click opens `#media-viewer` without opening contact details; name/header click opens the side panel and loads three media previews; `Ver tudo` paginates; selecting a preview calls `/api/media` only for that item; switching chats ignores the earlier response.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```powershell
node --test tests/frontend.test.cjs --test-name-pattern "profile photo|contact media"
```

Expected: FAIL because avatar/name are one button and the gallery module is absent.

- [ ] **Step 3: Expose cached avatar loading**

Refactor `public/avatars.js` so the internal request returns a shared promise and expose:

```js
load(chat) // => Promise<{url,mimeType}|null>
```

Keep `decorate()` behavior and cache limits unchanged. `load()` must reuse a fresh cache entry, never return raw connector fields, and return `null` after a safe failure.

- [ ] **Step 4: Split avatar and header actions in semantic HTML**

Replace the single `#contact-header-info` button with:

```html
<button id="contact-avatar-open" class="avatar contact-avatar-button" type="button" aria-label="Abrir foto do contato"><span id="contact-avatar"></span></button>
<button id="contact-header-info" class="contact-header-info" type="button" aria-controls="contact-panel"><span class="contact-header-copy"><span id="contact-name"></span><span id="contact-phone"></span></span></button>
```

Add a media preview section under `#contact-details` and a `#contact-media-dialog` containing status, grid, and `Carregar mais` controls.

- [ ] **Step 5: Implement the contact-media browser module**

Create `WhatsAppContactMedia.init({api,notice,getSelected,toggleContact,openMedia})`. It must:

- open the cached profile image through the existing `WhatsAppMedia.open`;
- call `toggleContact(true)` and select the attendance tab when the header/name is clicked;
- fetch page 1 for the three-item side preview;
- reset and paginate the full gallery in the dialog;
- use an incrementing selection token plus `AbortController` to ignore stale work;
- fetch bytes through `/media` only after an item click;
- show initials/notice for absent profile photos and inline unavailable tiles for missing media.

- [ ] **Step 6: Register assets and integrate module lifecycle**

Add `/assets/contact-media.js` and `/assets/contact-media.css` to the server allowlist and `public/index.html`. Initialize after avatar/media modules, call `onSelect(chat)` from `selectChat`, and call `onSelect(null)` on back/navigation cleanup.

- [ ] **Step 7: Add responsive CSS and Playwright coverage**

Use a three-column square grid in the contact panel, four-to-six columns in the full dialog depending on width, visible keyboard focus, and a single-column conversation when the panel is closed. Verify desktop and 390px layouts, avatar viewer, media side panel, pagination, and return to the same draft after closing the viewer.

- [ ] **Step 8: Run and commit**

Run:

```powershell
node --test tests/frontend.test.cjs tests/contact-media.test.cjs
npx playwright test tests/e2e/workspace.spec.cjs --grep "profile photo|contact media gallery|navigation and composer"
```

Expected: all selected tests pass.

Commit:

```powershell
git add public/contact-media.js public/contact-media.css public/avatars.js public/index.html public/app.js server.cjs tests/frontend.test.cjs tests/e2e/workspace.spec.cjs
git commit -m "feat: browse contact photos and media"
```

### Task 7: Integrated regression and visual verification

**Files:**
- Modify only if a regression is proven by the commands below.

- [ ] **Step 1: Run formatting and source checks**

Run:

```powershell
git diff --check
node --check server.cjs
node --check lib/group-presentation.cjs
node --check lib/evolution.cjs
node --check public/app.js
node --check public/group-order.js
node --check public/contact-media.js
```

Expected: every command exits 0 with no syntax or whitespace errors.

- [ ] **Step 2: Run the complete Node suite**

Run:

```powershell
npm test
```

Expected: 0 failed tests; existing intentional skips remain skips.

- [ ] **Step 3: Run the complete relevant Playwright suite**

Run:

```powershell
npx playwright test tests/e2e/workspace.spec.cjs tests/e2e/prospection.spec.cjs --reporter=line
```

Expected: all tests pass. If the known transcription-priority test is marked flaky, rerun that exact test twice and require both repetitions to pass before proceeding.

- [ ] **Step 4: Perform visual QA at three sizes**

Capture and inspect screenshots at `1440x960`, `1133x637`, and `390x844`. Confirm:

- no conversation total appears in card, `Todas`, inbox heading, or title;
- remaining metric value and label share one line;
- title count equals unread messages;
- pinned and normal group blocks are legible and menus do not cover badges;
- avatar and contact-name targets are distinct;
- media gallery remains inside viewport;
- native select controls and opened options are opaque and readable.

- [ ] **Step 5: Verify private cache and per-account behavior**

Run the PWA and account-focused tests:

```powershell
node --test tests/pwa.test.cjs tests/accounts.test.cjs tests/group-presentation.test.cjs tests/contact-media.test.cjs
```

Expected: APIs remain `no-store`, the service worker ignores `/api/`, and group preferences remain isolated by account.

- [ ] **Step 6: Commit any verification-only test adjustments**

Only if a test fixture required a proven compatibility update:

```powershell
git add tests
git commit -m "test: cover Whats AI conversation interface"
```

Do not include the pre-existing deletion of `scripts/start-central.ps1` unless the user separately authorizes resolving it.
