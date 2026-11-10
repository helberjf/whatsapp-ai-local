# Whats AI PWA and Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canonical Whats AI launcher open the ready local application directly in the default browser, add a safe installable PWA with an original Whats AI identity, and remove broken legacy `.cmd` aliases.

**Architecture:** Keep startup orchestration in the existing PowerShell/Node launcher path and expose PWA resources through the existing allow-listed static server. Use a hand-authored SVG as the visual source, generate deterministic PNG/ICO derivatives at development time, and use a network-first service worker that never caches APIs, health responses, conversations, or media.

**Tech Stack:** Node.js 22, CommonJS, native `node:test`, PowerShell 5, plain HTML/CSS/JavaScript, Playwright/Chromium for deterministic icon rendering and browser verification.

---

## File map

- Create `public/icons/whats-ai.svg`: single source of truth for the original brand symbol.
- Create `public/icons/whats-ai-192.png`, `public/icons/whats-ai-512.png`, `public/icons/whats-ai-maskable-512.png`, and `public/icons/whats-ai.ico`: generated browser, PWA, and Windows assets.
- Create `scripts/build-icons.cjs`: deterministic generator for the committed raster and ICO assets.
- Create `public/manifest.webmanifest`: installation metadata and icon declarations.
- Create `public/service-worker.js`: network-first application-shell worker with private-route exclusions.
- Create `public/offline.html`: branded explanation shown only when navigation cannot reach the local server.
- Create `public/pwa.js`: service-worker registration isolated from the main application code.
- Create `tests/pwa.test.cjs`: static asset, manifest, service-worker safety, and HTML metadata contract tests.
- Modify `server.cjs`: serve the new allow-listed resources with correct MIME and cache headers.
- Modify `public/index.html`: add PWA metadata, brand asset, and registration script.
- Modify `public/app.css`: size and polish the new sidebar brand symbol.
- Modify `scripts/shortcut.ps1`: target the canonical launcher and use the generated ICO.
- Modify `scripts/autostart.ps1`: target the canonical launcher with `-NoBrowser`.
- Modify `tests/launcher.test.cjs`: cover canonical targets and removed legacy aliases.
- Modify `tests/server.test.cjs`: verify PWA resources and response headers through the real HTTP server.
- Modify `tests/e2e/workspace.spec.cjs`: verify visible branding and successful service-worker registration.
- Delete `Abrir WhatsApp.cmd`, `Iniciar WhatsApp.cmd`, and `Parar WhatsApp.cmd`: broken or duplicate legacy aliases.
- Modify `README.md`: document the single start/stop pair and optional PWA installation.

### Task 1: Lock down the PWA and icon contracts

**Files:**
- Create: `tests/pwa.test.cjs`
- Create: `public/icons/whats-ai.svg`
- Create: `scripts/build-icons.cjs`
- Create: `public/icons/whats-ai-192.png`
- Create: `public/icons/whats-ai-512.png`
- Create: `public/icons/whats-ai-maskable-512.png`
- Create: `public/icons/whats-ai.ico`

- [ ] **Step 1: Write the failing asset contract test**

Create `tests/pwa.test.cjs` with helpers that read files from the repository and parse PNG dimensions from bytes 16-23:

```js
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file));
const text=file=>read(file).toString('utf8');
const pngSize=file=>{const value=read(file);assert.deepEqual([...value.subarray(0,8)],[137,80,78,71,13,10,26,10]);return [value.readUInt32BE(16),value.readUInt32BE(20)];};

test('identidade Whats AI tem fonte vetorial, PNGs PWA e ícone do Windows',()=>{
  const svg=text('public/icons/whats-ai.svg');
  assert.match(svg,/aria-label="Whats AI"/);
  assert.match(svg,/>AI</);
  assert.deepEqual(pngSize('public/icons/whats-ai-192.png'),[192,192]);
  assert.deepEqual(pngSize('public/icons/whats-ai-512.png'),[512,512]);
  assert.deepEqual(pngSize('public/icons/whats-ai-maskable-512.png'),[512,512]);
  const ico=read('public/icons/whats-ai.ico');
  assert.deepEqual([...ico.subarray(0,4)],[0,0,1,0]);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test tests/pwa.test.cjs`

Expected: FAIL with `ENOENT` for `public/icons/whats-ai.svg`.

- [ ] **Step 3: Add the original SVG source**

Create a square SVG with a rounded dark-green tile, a lighter asymmetric conversation bubble, a small sparkle, and centered white `AI` lettering. Use only local vector elements, include `role="img" aria-label="Whats AI"`, preserve a generous safe zone for maskable crops, and do not include the WhatsApp telephone glyph.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Whats AI">
  <rect width="512" height="512" rx="112" fill="#102b25"/>
  <path d="M112 122c0-35 29-64 64-64h160c35 0 64 29 64 64v174c0 35-29 64-64 64H228l-82 66 18-72c-30-6-52-32-52-63V122Z" fill="#20c77a"/>
  <path d="m349 94 8 22 22 8-22 8-8 22-8-22-22-8 22-8 8-22Z" fill="#b8ffdc"/>
  <text x="256" y="273" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="124" font-weight="800" letter-spacing="-8" fill="#fff">AI</text>
</svg>
```

- [ ] **Step 4: Add deterministic raster/ICO generation**

Create `scripts/build-icons.cjs` that launches the installed Playwright Chromium, opens the SVG with a transparent viewport, screenshots the SVG element at 192 and 512 pixels, and writes both regular PNGs. Render the maskable variant from the same SVG with the symbol constrained to the central 80% safe zone. Build the ICO as an ICO header plus one directory entry followed by the 256x256 PNG payload; do not add a runtime dependency.

The script must exit non-zero on a dimension mismatch and print exactly `Ícones Whats AI atualizados.` on success. Run it with:

```powershell
node scripts/build-icons.cjs
```

- [ ] **Step 5: Run the test and confirm GREEN**

Run: `node --test tests/pwa.test.cjs`

Expected: PASS for the identity asset test.

- [ ] **Step 6: Commit the isolated asset work**

```powershell
git add tests/pwa.test.cjs public/icons scripts/build-icons.cjs
git commit -m "feat: add Whats AI visual identity"
```

### Task 2: Add safe PWA resources and HTTP delivery

**Files:**
- Modify: `tests/pwa.test.cjs`
- Modify: `tests/server.test.cjs`
- Create: `public/manifest.webmanifest`
- Create: `public/service-worker.js`
- Create: `public/offline.html`
- Modify: `server.cjs:215-234`

- [ ] **Step 1: Write failing manifest and service-worker tests**

Append tests that require the manifest to contain `name: "Whats AI"`, `short_name`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, theme/background colors, and 192/512/maskable icons. Assert that the service worker contains an explicit private-route rejection and a network-first navigation handler:

```js
test('manifesto instala o Whats AI com ícones normal e maskable',()=>{
  const manifest=JSON.parse(text('public/manifest.webmanifest'));
  assert.equal(manifest.name,'Whats AI');
  assert.equal(manifest.start_url,'/');
  assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');
  assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'));
  assert.ok(manifest.icons.some(icon=>icon.sizes==='512x512' && icon.purpose==='maskable'));
});

test('service worker nunca guarda API, saúde, conversas ou mídia',()=>{
  const worker=text('public/service-worker.js');
  assert.match(worker,/pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker,/pathname==='\/health'/);
  assert.match(worker,/request\.mode==='navigate'/);
  assert.match(worker,/fetch\(request\)/);
  assert.doesNotMatch(worker,/cache\.put\(request/);
});
```

In `tests/server.test.cjs`, add GET assertions for `/manifest.webmanifest`, `/service-worker.js`, `/offline.html`, `/icons/whats-ai.svg`, the PNGs, and `/icons/whats-ai.ico`, including MIME types and `Service-Worker-Allowed: /`.

- [ ] **Step 2: Run both tests and confirm RED**

Run: `node --test tests/pwa.test.cjs tests/server.test.cjs`

Expected: FAIL because the manifest/service worker do not exist and HTTP routes return 404.

- [ ] **Step 3: Create manifest, worker, and offline page**

Use this manifest contract:

```json
{
  "name": "Whats AI",
  "short_name": "Whats AI",
  "description": "Central local de atendimento, CRM e inteligência artificial.",
  "lang": "pt-BR",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#10151d",
  "theme_color": "#102b25",
  "icons": [
    {"src":"/icons/whats-ai-192.png","sizes":"192x192","type":"image/png","purpose":"any"},
    {"src":"/icons/whats-ai-512.png","sizes":"512x512","type":"image/png","purpose":"any"},
    {"src":"/icons/whats-ai-maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}
  ]
}
```

Implement `public/service-worker.js` with a versioned cache containing only `/offline.html` and `/icons/whats-ai.svg`. On navigation, try `fetch(request)` and fall back to the cached offline page. For `/api/`, `/health`, `/assets/`, `/icons/`, and all non-GET requests, return `fetch(request)` directly. Do not call `cache.put` for request responses.

Create `public/offline.html` as a self-contained page with inline styles allowed only for this separate response, the Whats AI SVG, the title `Whats AI está fechado`, and the instruction `Abra “Iniciar WhatsApp Central” e tente novamente.`

- [ ] **Step 4: Extend the static allow-list safely**

In `server.cjs`, replace the single flat text-only static block with a small map from exact URL path to `{file,type,binary,headers}`. Keep every route allow-listed, read binary icons without UTF-8 conversion, preserve token injection only for `index.html`, and set:

```js
'/manifest.webmanifest': {file:'manifest.webmanifest',type:'application/manifest+json; charset=utf-8'},
'/service-worker.js': {file:'service-worker.js',type:'text/javascript; charset=utf-8',headers:{'Service-Worker-Allowed':'/'}},
'/offline.html': {file:'offline.html',type:'text/html; charset=utf-8'},
'/icons/whats-ai.svg': {file:'icons/whats-ai.svg',type:'image/svg+xml'},
'/icons/whats-ai-192.png': {file:'icons/whats-ai-192.png',type:'image/png',binary:true},
'/icons/whats-ai-512.png': {file:'icons/whats-ai-512.png',type:'image/png',binary:true},
'/icons/whats-ai-maskable-512.png': {file:'icons/whats-ai-maskable-512.png',type:'image/png',binary:true},
'/icons/whats-ai.ico': {file:'icons/whats-ai.ico',type:'image/x-icon',binary:true}
```

Override the global `no-store` only for immutable icon files with `Cache-Control: public, max-age=31536000, immutable`; keep the manifest, service worker, HTML, APIs, and health endpoint as `no-store`.

- [ ] **Step 5: Run tests and confirm GREEN**

Run: `node --test tests/pwa.test.cjs tests/server.test.cjs`

Expected: all tests PASS with no warnings.

- [ ] **Step 6: Commit PWA delivery**

```powershell
git add public/manifest.webmanifest public/service-worker.js public/offline.html server.cjs tests/pwa.test.cjs tests/server.test.cjs
git commit -m "feat: serve safe installable PWA"
```

### Task 3: Integrate branding and registration into the interface

**Files:**
- Modify: `tests/pwa.test.cjs`
- Create: `public/pwa.js`
- Modify: `public/index.html:3-25,75-80`
- Modify: `public/app.css`
- Modify: `server.cjs` static map from Task 2

- [ ] **Step 1: Write the failing HTML integration test**

Add assertions for the manifest, theme color, SVG favicon, Apple touch icon, registration script, and visible brand image:

```js
test('página publica metadados PWA e a nova marca',()=>{
  const html=text('public/index.html');
  assert.match(html,/<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html,/<meta name="theme-color" content="#102b25">/);
  assert.match(html,/<link rel="icon" href="\/icons\/whats-ai\.svg" type="image\/svg\+xml">/);
  assert.match(html,/<link rel="apple-touch-icon" href="\/icons\/whats-ai-192\.png">/);
  assert.match(html,/<script defer src="\/pwa\.js"><\/script>/);
  assert.match(html,/class="brand-logo"[^>]+src="\/icons\/whats-ai\.svg"/);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test tests/pwa.test.cjs`

Expected: FAIL because PWA metadata and `brand-logo` are absent.

- [ ] **Step 3: Add metadata, registration, and visible logo**

Add the metadata to `<head>`, load `/pwa.js`, replace only the existing generated chat icon inside `.brand-icon` with:

```html
<img class="brand-logo" src="/icons/whats-ai.svg" alt="">
```

Create `public/pwa.js`:

```js
(()=>{
  if(!('serviceWorker' in navigator) || location.protocol!=='http:') return;
  addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js',{scope:'/'}).catch(()=>{}),{once:true});
})();
```

Add `/pwa.js` to the exact server allow-list. In `public/app.css`, make `.brand-icon` a 34px square without changing the brand text layout and set `.brand-logo{display:block;width:100%;height:100%;border-radius:9px}`.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `node --test tests/pwa.test.cjs tests/server.test.cjs tests/frontend.test.cjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit interface integration**

```powershell
git add public/index.html public/app.css public/pwa.js server.cjs tests/pwa.test.cjs
git commit -m "feat: integrate Whats AI PWA branding"
```

### Task 4: Canonicalize Windows launchers and delete broken aliases

**Files:**
- Modify: `tests/launcher.test.cjs`
- Modify: `scripts/shortcut.ps1`
- Modify: `scripts/autostart.ps1`
- Delete: `Abrir WhatsApp.cmd`
- Delete: `Iniciar WhatsApp.cmd`
- Delete: `Parar WhatsApp.cmd`
- Preserve: `Iniciar WhatsApp Central.cmd`
- Preserve: `Parar WhatsApp Central.cmd`

- [ ] **Step 1: Write failing launcher topology tests**

Replace the launcher file assertions with a canonical topology test:

```js
test('somente os iniciadores canônicos de abrir e parar permanecem',()=>{
  const root=path.join(__dirname,'..');
  assert.equal(fs.existsSync(path.join(root,'Iniciar WhatsApp Central.cmd')),true);
  assert.equal(fs.existsSync(path.join(root,'Parar WhatsApp Central.cmd')),true);
  for(const legacy of ['Abrir WhatsApp.cmd','Iniciar WhatsApp.cmd','Parar WhatsApp.cmd']) {
    assert.equal(fs.existsSync(path.join(root,legacy)),false,legacy+' deve ser removido');
  }
});

test('atalhos do Windows chamam o launcher canônico e usam a marca Whats AI',()=>{
  const shortcut=fs.readFileSync(path.join(__dirname,'..','scripts','shortcut.ps1'),'utf8');
  const autostart=fs.readFileSync(path.join(__dirname,'..','scripts','autostart.ps1'),'utf8');
  assert.match(shortcut,/Iniciar WhatsApp Central\.cmd/);
  assert.match(shortcut,/public\\icons\\whats-ai\.ico/);
  assert.match(autostart,/Iniciar WhatsApp Central\.cmd/);
  assert.match(autostart,/-NoBrowser/);
  assert.doesNotMatch(shortcut+autostart,/scripts\\start\.ps1/);
});
```

Keep the existing test proving `Iniciar WhatsApp Central.cmd` calls `open-central.cjs`, preserves CRLF, forwards arguments, and returns its exit code.

- [ ] **Step 2: Run the launcher tests and confirm RED**

Run: `node --test tests/launcher.test.cjs`

Expected: FAIL because legacy aliases still exist and shortcut scripts target `scripts/start.ps1`.

- [ ] **Step 3: Repoint shortcut creation and autostart**

In `scripts/shortcut.ps1`, use `cmd.exe /d /c "<project>\Iniciar WhatsApp Central.cmd"`, preserve the hidden window behavior, and set `IconLocation` to `public\icons\whats-ai.ico,0`.

In `scripts/autostart.ps1`, use the same canonical `.cmd` target plus `-NoBrowser`. Preserve ownership checks so the scripts never overwrite unrelated user shortcuts. Update the ownership comparison to accept the old `scripts/start.ps1` arguments only for migration/removal, not for newly created shortcuts.

- [ ] **Step 4: Delete only the verified legacy aliases**

Use `apply_patch` to delete exactly:

```text
Abrir WhatsApp.cmd
Iniciar WhatsApp.cmd
Parar WhatsApp.cmd
```

Do not delete the automatic-start or shortcut-management commands; they remain supported utilities.

- [ ] **Step 5: Run launcher tests and confirm GREEN**

Run: `node --test tests/launcher.test.cjs`

Expected: all launcher tests PASS.

- [ ] **Step 6: Commit launcher cleanup**

```powershell
git add tests/launcher.test.cjs scripts/shortcut.ps1 scripts/autostart.ps1 "Abrir WhatsApp.cmd" "Iniciar WhatsApp.cmd" "Parar WhatsApp.cmd"
git commit -m "fix: keep one working Whats AI launcher"
```

### Task 5: Verify installed-mode behavior in Chromium

**Files:**
- Modify: `tests/e2e/workspace.spec.cjs`
- Modify: `public/service-worker.js` only if the behavioral test exposes a defect

- [ ] **Step 1: Write the failing browser test**

Add a test that opens the existing demo fixture, verifies the visible logo, waits for service-worker readiness, fetches the manifest, and confirms private API responses are not present in Cache Storage:

```js
test('expõe marca e PWA sem guardar respostas privadas',async({page})=>{
  await page.goto('/');
  await expect(page.locator('.brand-logo')).toBeVisible();
  await page.evaluate(()=>navigator.serviceWorker.ready);
  const manifest=await page.evaluate(()=>fetch('/manifest.webmanifest').then(response=>response.json()));
  expect(manifest).toMatchObject({name:'Whats AI',display:'standalone'});
  await page.evaluate(()=>fetch('/api/chats').catch(()=>null));
  const cached=await page.evaluate(async()=>{
    const names=await caches.keys(),urls=[];
    for(const name of names) for(const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    return urls;
  });
  expect(cached.some(path=>path.startsWith('/api/'))).toBe(false);
});
```

- [ ] **Step 2: Run the browser test and confirm RED or validate the new contract**

Run: `npx playwright test tests/e2e/workspace.spec.cjs --grep "expõe marca e PWA"`

Expected before Task 3 integration: FAIL because `.brand-logo` or service-worker registration is unavailable. If Tasks 1-3 already make it pass, temporarily assert an intentionally wrong manifest name once, observe the expected failure, restore the correct assertion, and rerun to retain RED/GREEN evidence.

- [ ] **Step 3: Make the minimal correction if needed**

Change only the behavior demonstrated by the failing assertion. Do not cache `/api/`, `/health`, message media, application responses containing session tokens, or runtime navigation responses.

- [ ] **Step 4: Run the focused browser test and confirm GREEN**

Run: `npx playwright test tests/e2e/workspace.spec.cjs --grep "expõe marca e PWA"`

Expected: 1 passed.

- [ ] **Step 5: Commit browser coverage**

```powershell
git add tests/e2e/workspace.spec.cjs public/service-worker.js
git commit -m "test: cover Whats AI installed experience"
```

### Task 6: Documentation and full verification

**Files:**
- Modify: `README.md:66-105`

- [ ] **Step 1: Update the user-facing launcher documentation**

Document that `Iniciar WhatsApp Central.cmd` is the single supported interactive launcher, `Parar WhatsApp Central.cmd` is the supported stop command, the start command opens the default browser after readiness, and the browser's install action can add Whats AI as an app. Remove statements that advertise the deleted aliases.

- [ ] **Step 2: Run focused static and unit verification**

Run:

```powershell
node --test tests/pwa.test.cjs tests/launcher.test.cjs tests/server.test.cjs tests/frontend.test.cjs
```

Expected: all tests PASS with zero failures and no unhandled-rejection warnings.

- [ ] **Step 3: Run the complete unit suite**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 4: Run the relevant end-to-end suite**

Run: `npx playwright test tests/e2e/workspace.spec.cjs`

Expected: all workspace tests PASS and the HTML report contains no new failures.

- [ ] **Step 5: Perform visual QA**

Start the demo without touching production data, open it at desktop width 1440x960 and mobile width 390x844, and inspect screenshots for: crisp icon edges, readable `AI`, no sidebar alignment regression, correct standalone colors, and a usable offline explanation. Stop the demo afterward.

- [ ] **Step 6: Check repository scope**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only the feature's files plus the user's pre-existing unrelated changes are listed. Do not stage or amend the unrelated changes.

- [ ] **Step 7: Commit documentation**

```powershell
git add README.md
git commit -m "docs: explain Whats AI browser and PWA launch"
```
