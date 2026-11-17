# Whats AI Visual Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the normal console-heavy startup with a compact branded Windows loading window that tracks real launcher progress and stays open with a friendly error on failure.

**Architecture:** A testable Node adapter runs the existing canonical launcher, maps its output to four status events, and appends technical output to `data/launcher.log`. A PowerShell WPF window consumes those status events while keeping the child process hidden. A tiny VBScript entry point starts WPF without flashing a console, and Windows shortcuts target that entry point.

**Tech Stack:** Node.js 22, Windows PowerShell 5.1, WPF/XAML, VBScript/WScript, Node test runner.

---

## File map

- Create `scripts/launcher-ui.cjs`: process adapter, status classifier, append-only logging, and CLI entry point.
- Create `scripts/start-ui.ps1`: branded WPF window and asynchronous consumption of adapter output.
- Create `scripts/open-central-ui.vbs`: no-console entry point for shortcuts.
- Modify `scripts/shortcut.ps1`: point the desktop shortcut to WScript and migrate owned older targets.
- Modify `scripts/autostart.ps1`: point startup shortcut to WScript with `-NoBrowser`.
- Modify `tests/launcher.test.cjs`: behavioral coverage for the adapter and structural coverage for Windows entry points.
- Modify `README.md`: document visual opening, diagnostic launcher, and log location.

### Task 1: Testable progress adapter

**Files:**
- Create: `scripts/launcher-ui.cjs`
- Modify: `tests/launcher.test.cjs`

- [ ] **Step 1: Write the failing classifier and runner tests**

Add imports for `EventEmitter`, then add tests that require `classifyLine` and `runVisualLauncher` from the new module. Assert these mappings:

```js
assert.deepEqual(classifyLine('Configuração local pronta. Segredos preservados.'),{step:2,status:'Iniciando serviços...'});
assert.deepEqual(classifyLine('Preparando WhatsApp, banco e sessão persistente…'),{step:3,status:'Conectando ao WhatsApp...'});
assert.deepEqual(classifyLine('Banco PostgreSQL da central pronto.'),{step:4,status:'Abrindo a Central...'});
assert.deepEqual(classifyLine('Central ja iniciada. Reutilizando a sessao.'),{step:4,status:'Central pronta.',done:true});
assert.equal(classifyLine('uma linha técnica qualquer'),null);
```

Use a fake child process with `stdout` and `stderr` event emitters. Verify that `runVisualLauncher({spawn,append,emit,root,extraArgs:['-NoBrowser']})` invokes `open-central.cjs` with `windowsHide:true`, captures both streams, emits status objects, appends a start marker and exit code, and resolves to the child's code.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/launcher.test.cjs`

Expected: FAIL with `Cannot find module '../scripts/launcher-ui.cjs'`.

- [ ] **Step 3: Implement the minimal Node adapter**

Implement `classifyLine(line)` with stable substring checks and `runVisualLauncher(deps={})` with injected `spawn`, `append`, and `emit`. The real defaults must:

```js
const child=spawn(process.execPath,[path.join(root,'scripts','open-central.cjs'),...extraArgs],{
  cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']
});
```

Append timestamped start, stdout, stderr, spawn errors, and `exit=<code>` to `data/launcher.log`. Emit machine-readable UI events to the parent as `@@WHATS_AI_STATUS ${JSON.stringify(event)}`. Export both functions, and only run the CLI under `if(require.main===module)`. Preserve `-NoBrowser` exactly.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/launcher.test.cjs`

Expected: all launcher tests pass.

- [ ] **Step 5: Commit the adapter**

```powershell
git add scripts/launcher-ui.cjs tests/launcher.test.cjs
git commit -m "feat: acompanha progresso da abertura"
```

### Task 2: Native WPF loading window

**Files:**
- Create: `scripts/start-ui.ps1`
- Create: `scripts/open-central-ui.vbs`
- Modify: `tests/launcher.test.cjs`

- [ ] **Step 1: Write failing entry-point tests**

Read both new files and assert:

```js
assert.match(vbs,/wscript\.exe|WScript\.Shell/i);
assert.match(vbs,/start-ui\.ps1/i);
assert.match(vbs,/-WindowStyle Hidden/i);
assert.match(vbs,/-NoBrowser/i);
assert.match(ui,/PresentationFramework/);
assert.match(ui,/launcher-ui\.cjs/);
assert.match(ui,/CreateNoWindow\s*=\s*\$true/);
assert.match(ui,/data[\\/]launcher\.log/);
assert.match(ui,/Central pronta/);
assert.match(ui,/Fechar/);
assert.match(ui,/ShowDialog/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/launcher.test.cjs`

Expected: FAIL because `scripts/start-ui.ps1` and `scripts/open-central-ui.vbs` do not exist.

- [ ] **Step 3: Implement the invisible VBScript entry point**

Create `scripts/open-central-ui.vbs` that resolves its own folder, builds this command, forwards only the recognized `-NoBrowser` switch, and calls `WScript.Shell.Run command, 0, False`:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<scripts>\start-ui.ps1" [-NoBrowser]
```

Before launching, create `<project>\data` if it does not exist. If `Run` raises an error, append it to `<project>\data\launcher.log` and display a native `MsgBox` explaining that Whats AI could not start.

- [ ] **Step 4: Implement the WPF window**

Create `scripts/start-ui.ps1` with `param([switch]$NoBrowser)`, `Add-Type -AssemblyName PresentationFramework`, and XAML for a 440×330 centered, non-resizable dark window. Include:

- the existing `public/icons/whats-ai.ico` inside a circular spinner;
- title `Whats AI`;
- status text initialized to `Preparando configurações...`;
- determinate progress values 25, 50, 75, and 100;
- an indefinitely rotating ring storyboard;
- a hidden error panel naming `data\launcher.log`;
- a hidden **Fechar** button that becomes visible only after failure.

Start `node scripts/launcher-ui.cjs` with `UseShellExecute=$false`, redirected output/error, and `CreateNoWindow=$true`. Use `ReadLineAsync()` plus a WPF `DispatcherTimer` so the UI remains responsive. Parse only lines beginning with `@@WHATS_AI_STATUS `, deserialize their JSON, update progress/status, and ignore technical lines. On exit code 0, show `Central pronta.` at 100% and close after a 500 ms dispatcher timer. On any nonzero exit or process-start exception, append the exception to `data\launcher.log`, stop the spinner, show `Não foi possível abrir o Whats AI.`, reveal the log hint and **Fechar**, and leave the window open. Finish with `$null=$window.ShowDialog()`.

- [ ] **Step 5: Run focused tests and a PowerShell parse check**

Run:

```powershell
node --test tests/launcher.test.cjs
$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/start-ui.ps1'),[ref]$null,[ref]$errors) | Out-Null; if($errors.Count){$errors | Format-List; exit 1}
```

Expected: launcher tests pass and the parser exits 0 with no errors.

- [ ] **Step 6: Commit the visual window**

```powershell
git add scripts/start-ui.ps1 scripts/open-central-ui.vbs tests/launcher.test.cjs
git commit -m "feat: adiciona carregamento visual do Whats AI"
```

### Task 3: Route Windows shortcuts through the visual launcher

**Files:**
- Modify: `scripts/shortcut.ps1`
- Modify: `scripts/autostart.ps1`
- Modify: `tests/launcher.test.cjs`

- [ ] **Step 1: Replace old shortcut assertions with failing visual-launcher assertions**

Assert that both shortcut scripts set `TargetPath` to `wscript.exe`, arguments to `open-central-ui.vbs`, and retain the icon and working directory. Assert that autostart includes `-NoBrowser`. Keep old `cmd.exe`, `start.ps1`, and previous VBS argument shapes in each ownership allowlist so project-owned shortcuts can be migrated safely.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/launcher.test.cjs`

Expected: FAIL because the shortcut scripts still target `cmd.exe`.

- [ ] **Step 3: Update desktop shortcut generation**

In `scripts/shortcut.ps1`, set:

```powershell
$launcherPath=Join-Path $PSScriptRoot 'open-central-ui.vbs'
$arguments='"'+$launcherPath+'"'
$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
```

Preserve the existing collision guard, icon, working directory, description, and migration of shortcuts owned by this project.

- [ ] **Step 4: Update autostart shortcut generation**

In `scripts/autostart.ps1`, use the same target and set arguments to `"<path>" -NoBrowser`. Preserve removal behavior and recognize prior project-owned `cmd.exe`/PowerShell argument forms during migration.

- [ ] **Step 5: Run launcher tests and recreate the desktop shortcut**

Run:

```powershell
node --test tests/launcher.test.cjs
npm run shortcut
```

Expected: tests pass and output contains `Atalho pronto:`.

- [ ] **Step 6: Commit shortcut migration**

```powershell
git add scripts/shortcut.ps1 scripts/autostart.ps1 tests/launcher.test.cjs
git commit -m "feat: abre Whats AI sem janela de comando"
```

### Task 4: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Test: `tests/launcher.test.cjs`

- [ ] **Step 1: Update launcher documentation**

Document that the desktop shortcut opens a visual progress window, failures stay visible, `data/launcher.log` contains technical details, and `Iniciar WhatsApp Central.cmd`/`npm start` remain the diagnostic textual launchers.

- [ ] **Step 2: Run the complete automated suite**

Run: `npm test`

Expected: zero failures.

- [ ] **Step 3: Run static Windows checks**

Run:

```powershell
git diff --check
$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/start-ui.ps1'),[ref]$null,[ref]$errors) | Out-Null; if($errors.Count){$errors | Format-List; exit 1}
```

Expected: both commands exit 0.

- [ ] **Step 4: Exercise the real visual launcher**

Run: `wscript.exe scripts\open-central-ui.vbs`

Observe that no console window remains visible, the four statuses advance, the window closes after success, and the browser opens Whats AI. Then run:

```powershell
Invoke-RestMethod http://127.0.0.1:8766/health | ConvertTo-Json
Get-Content data\launcher.log -Tail 30
```

Expected: health reports `service: whatsapp-local` and the log ends with `exit=0`.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md
git commit -m "docs: explica abertura visual da central"
```

- [ ] **Step 6: Push the completed change**

```powershell
git fetch origin
git push origin HEAD:main
```

Expected: `origin/main` advances to the final documentation commit without a non-fast-forward error.
