# Testing and validation

On **2026-11-07**, after joining the GitHub line (SQLite in tests, team operations, voice flow, multiple accounts) with the local line (PostgreSQL, AI model selection, media previews, dashboard, read state), **391 Node tests** passed with `WHATSAPP_PG_TEST=1`, and the unified code was checked against a copy of the production PostgreSQL schema: accounts, contacts, quick replies, knowledge documents and texts, products, AI provider/model and assistant rules matched the source, and the original schema was only read.

On **2026-11-01**, the PostgreSQL/media work was checked with **48 focused frontend/media tests** and **3 browser preview scenarios**. PostgreSQL integration tests use a real local database and isolated schemas; they were repeated after restoring Docker Desktop availability. Production checks confirmed the PostgreSQL backend, an existing connected WhatsApp session, preserved migration source hashes and no plaintext credential fields in the configuration documents.

Verified on Windows on **2026-10-29**: **255 Node tests** and **17 Playwright tests** passed. The browser suite covers 1440×960, 1133×637 and 390×844 layouts, media playback, safe links, trigger creation, contact details, deletion confirmation and timer options, plus local AI startup and an explicit CPU mode. New conversation checks cover the expanded message area, sidebar search, in-app image/PDF viewing, microphone recording/review/cancellation, permission denial, and rejection of an HTML payload mislabeled as PDF. Connector operations use fixtures; no real messages are sent or deleted for verification. Existing checks cover unclipped message-action popovers, a single attachment picker, Enter/Shift+Enter behavior, one-click video playback and suggestions based on both sides of the latest dialogue.

The project separates automated fixture validation from operations against a real linked WhatsApp account. Automated tests and the portfolio demo use fictional contacts, isolated temporary stores, and controlled connector responses. They must not be pointed at production data or used to send test messages to real contacts.

## Run the suites

Use Node.js 22.13 or later from the repository root:

```powershell
npm ci
npm test
```

`npm test` runs `node --test tests/*.test.cjs`. Tests construct service instances with temporary directories and fake dependencies, including local HTTP connector fixtures. They do not require Docker, WhatsApp pairing, API keys, or a running production instance. The Windows credential test requires Windows DPAPI and is explicitly skipped on other platforms.

For browser verification, install the Playwright browser once and run the separate suite:

```powershell
npx playwright install chromium
npm run test:e2e
```

The browser suite starts its own fixture environment. Most specs exercise the real browser interface and application HTTP routes while replacing WhatsApp and AI network boundaries. `media-previews.spec.cjs` serves real frontend assets and browser media elements with API responses fulfilled in Playwright, isolating visual/lifecycle tests from connector and Windows loopback failures. Keep production services on their normal ports; the browser fixture is independent.

To test PostgreSQL, prepare the local database with the launcher, then explicitly opt in:

```powershell
$env:WHATSAPP_PG_TEST='1'
node --test --test-concurrency=1 tests/postgres.test.cjs
```

These tests use randomly named `qa_*` schemas in the dedicated central database and drop only those schemas after testing. They cover competing updates, transaction rollback, idempotent import, knowledge text, encrypted credential transfer, account restart/isolation, trigger media references, and the shared file sets (knowledge texts, product images, search vectors) with their one-time import from the former folders and the former knowledge text table. No production contact or configuration is edited. The ordinary suite skips these tests unless opted in. `bootstrap.test.cjs` separately verifies that an occupied HTTP port prevents initialization/migration.

`persisted-media.test.cjs` checks immutable attachment files, content hashes, the 10 MiB cap, rejected traversal/corruption and recovery after interrupted writes. Database records contain references rather than trigger attachment base64; original legacy files remain preserved after import.

The running central keeps its state in PostgreSQL. Without a database (tests and the demo), the same services use `data/central.sqlite` through the same store and file-set interfaces, so most suites need no Docker.

On Windows, native socket closes in the Playwright worker sometimes block for 7 to 10 seconds, which stalls the fixture server running in that process. The cause was not identified; it also happens on code from before multiple accounts, and always-on tracing makes it more frequent. The configuration therefore records traces only on retry, allows longer waits, and retries up to twice. A test that passes only on retry is listed as flaky: treat a repeated flake in the same test as a real signal.

Test totals can change as coverage grows. Use the command's final pass/fail/skip summary as the current result rather than a historical count in documentation.

### RAG browser tests and recording new ones

```powershell
npm run test:e2e:rag
npm run codegen
```

`tests/e2e/rag.spec.cjs` runs against the demo, whose AI fixture returns deterministic topic embeddings and fixed robot suggestions. It covers a question found only by meaning, an off-topic question with no passage, the strict level discarding a medium-confidence passage and persisting after reload, and robot suggestions entering the rule list switched off without being saved. `npm run codegen` opens the same demo with Playwright's recorder; the recording is saved in `tests/recordings/`, outside the suite, so copy its steps into a test that uses the `demo` fixture.

Keep large local models unloaded while running the suites. With Ollama models resident in CPU memory, unrelated timing-sensitive tests (Windows credential protection, video limits) failed under load and passed again after `ollama stop`.

## Coverage map

| Area | What the tests establish |
| --- | --- |
| HTTP boundary | Request validation, session token, origin/host checks, response contracts, and rejected malformed operations. |
| Connector adapter | Evolution request shapes, message normalization, private identifiers, contact names, profile availability, media behavior, and error handling. |
| Sending and forwarding | Explicit requests, draft preservation, stable request identifiers, and conservative handling of uncertain sends. |
| Scheduling | Persisted jobs, due time conversion, cancellation and editing restrictions, disconnect grace period, restart recovery, and no automatic repeat of uncertain sends. |
| Triggers | First-contact, keyword, business hours, inactivity, delays, ordered response sequences, master switch behavior, cooldowns, and coordination with other reply workers. |
| Retrieval | Hybrid BM25 + embedding fusion, per-document index reuse and rebuilds, provider fallbacks, per-passage confidence, strict/balanced/flexible filtering and prompts, AI-suggested robot questions validated and grounded, and the setup/test scripts run without the app open. |
| Assistant | Audience eligibility, opt-in boundaries, explicit contact overrides, pause/rate limits, handoff behavior, and late-response invalidation. |
| Frontend state | Safe text rendering, preserved composer changes, media element continuity, pagination, explicit save/cancel actions, and duplicate-click protection. |
| Multiple accounts | The paired account keeps its instance and data without a new QR code, a new account creates only its own instance, conversations, contacts, sends, schedules and automations stay with their account, an unknown account never falls back to the default, and disconnecting or removing one account leaves the others intact. The browser suite pairs and removes a second account against the demo connector. |
| Native message actions | Delete-for-everyone validation, polls, sticker input checks, disappearing-message capability negotiation, extension state, and rejected unconfirmed connector replies. |
| Knowledge and products | Document extraction, lexical retrieval, catalog validation, supported import formats, and source-backed answer preparation. |
| Transcription | Queue limits, retries, local/cloud selection, temporary file cleanup, persisted results, and controlled engine/provider failures. |
| WhatsApp operations | Normalized reactions, quotes, edits, locations and contact cards; quotes built from the connector's original message; voice notes, reactions, edits and native archive/unread/block applied only after connector confirmation; pin limit, mute periods, starred messages, presence preference, profile and privacy validation. |
| Voice flow | Automatic transcription only after activation and once per audio; AI reads only completed transcriptions; text/audio/mirror reply formats; text fallback with a log entry when voice generation fails; Windows and OpenAI speech engines with controlled processes and responses and temporary file cleanup. |
| High volume | Parallel AI generation within the configured limit, one task per contact, no duplicate answers, late or failed automatic replies marked **Sem resposta** exactly once, the label removed after a reply, and messages from before activation left alone. |
| Team | Waiting periods opened only by messages that need a reply and closed by any answer, AI/robot versus people attribution, deadlines, arrivals per hour, handoff counting once, history kept out of new arrivals, queue notices once per wait and never when the AI will answer, satisfaction polls at most once a day with votes counted, triage limited to listed subjects, settings validation, bulk actions, assignment checks, and the dashboard, `/` replies and transfer note in the browser. |
| Archive and contacts | The connector extension recording WhatsApp's archive state from history sync, updates and new chats in one write; the newest of phone and central archive actions winning; the read-only archive snapshot (snapshot plus following patches, never writing the session's sync state, newer live changes kept, groups ignored, missing keys reported), its one-time automatic run and the on-demand button; "Keep chats archived" off unarchiving chats with newer messages; the build identifier that lets the launcher restart an outdated central and the page warn about it; the **Arquivadas** row and every filter staying in view at three widths; and the contacts list joining the address book and conversations without duplicating phone and private identifiers, with search and pages. |
| Synchronization | Shared conversation list with one request for simultaneous callers, recent-only refresh between full listings, single-conversation checks, invalidation after sends, the Socket.IO event handshake, ping, instance filter and reconnection, an event starting a cycle in the server, change-only browser updates, and a 3,000-conversation browser list that renders only visible rows. |
| Transcription queue | Several audios at the same time within the configured limit, a configurable queue size, and the optional faster-whisper engine with its missing-package message. |
| Storage | One-time import into `data/central.sqlite` from the previous `atendimento.sqlite`, `atendimento.json`, `knowledge.json`, `produtos.json` and the knowledge text, product photo and vector folders (kept as `.migrado`), independent read snapshots, nothing written when an update fails, only the changed item rewritten, removals and reopening, ordered concurrent updates, JSON kept for the smaller files, and pruning of old reservations only. |
| Credentials | DPAPI round trip, separate assistant/transcription credentials, restart recovery, rotation/deletion, verified legacy migration, failure preservation, and safe errors. |

The focused UI tests execute the application code with a small DOM fixture to check behavior without coupling assertions to screenshot pixels. Playwright complements those tests with real browser rendering and user interactions.

## Isolated demo and screenshots

```powershell
npm run demo
```

Open [the local demo](http://127.0.0.1:8876/). The demo uses an OS temporary directory, a fake Evolution connector, controlled AI responses, and disabled background reply workers. It does not read the real account's `data/` directory or connect to Docker or external AI services. A visible demo banner identifies the fixture. Stop it with **Ctrl+C** to remove its temporary data during normal shutdown.

The README screenshots are captured from this environment. Normal browser runs write artifacts to ignored `test-results/`; to refresh documentation images, set `WHATSAPP_CAPTURE_DOCS=1` for the test process:

- [`screenshots/workspace.png`](screenshots/workspace.png): conversation layout, fictional contacts, and attendance panel.
- [`screenshots/media.png`](screenshots/media.png): sample media and message controls.
- [`screenshots/triggers.png`](screenshots/triggers.png): trigger conditions and response composer.
- [`screenshots/knowledge.png`](screenshots/knowledge.png): sample knowledge and grounded answer workflow.
- [`screenshots/local-ai.png`](screenshots/local-ai.png): local runtime readiness and CPU option.
- [`screenshots/voice-recorder.png`](screenshots/voice-recorder.png): browser microphone recording reviewed before sending, using a synthetic input device.
- [`screenshots/document-preview.png`](screenshots/document-preview.png): the sample PDF rendered in the local PDF.js reader.
- [`screenshots/whatsapp-features.png`](screenshots/whatsapp-features.png): quoted reply, reaction, edited message, shared location and contact card.
- [`screenshots/team-dashboard.png`](screenshots/team-dashboard.png): the team dashboard with fictional numbers.
- [`screenshots/voice-flow.png`](screenshots/voice-flow.png): the three voice flow stages, voice settings and a generated preview (a synthetic tone in the demo).

Screenshots demonstrate the UI state, not real-account delivery. Never replace them with captures that expose real messages, names, phone numbers, QR codes, session tokens, or keys.

## Useful manual checks

Perform these in the isolated demo or another explicitly authorized fixture environment:

1. Open a conversation, type a draft, and allow a refresh. The draft should remain. Open another chat and return to verify independent drafts.
2. Scroll through earlier messages. A refresh should preserve reading position and existing media players.
3. Load audio and video, seek, and change playback speed. Copy a message and inspect the forward dialog without confirming a real send.
4. Create a trigger with the master switch off. Save and reopen it; verify conditions, response order, attachments, and schedule survive. Cancel an edit and verify no rule changed.
5. Use the trigger simulator. It should show a matched rule or a clear no-match result without sending anything.
6. Select each assistant audience. Changing the selection alone should not save or enable responses; saving the audience should retain the master switch state.
7. Test narrow and short viewports. The trigger editor's message list should scroll while its save and cancel controls remain reachable. Dialogs need accessible labels and keyboard focus.
8. Try an unsupported or failed connector response. The UI should retain the draft and present a useful error without claiming success.

## What fixture tests do not prove

The suites do not establish live WhatsApp delivery, upstream account eligibility, complete historical synchronization, the availability of every profile field, or a guarantee of exactly-once delivery across network/process failures. Native operations can be rejected by WhatsApp despite a valid application request.

Cloud provider tests use controlled responses; they do not assert live model availability, account billing, or transcription quality. The optional Whisper integration depends on the installed Python packages, model, and FFmpeg. Knowledge retrieval is BM25 lexical ranking, so a high relative score does not prove the answer is complete or correct.

[`../tests/ai-credentials.test.cjs`](../tests/ai-credentials.test.cjs) covers the assistant credential boundary with controlled protection functions: no key in saved JSON, verified migration, restart recovery, preservation after failed migration, rotation, deletion, and safe error handling. [`../tests/credentials.test.cjs`](../tests/credentials.test.cjs) also exercises real Windows DPAPI on Windows. The general assistant key uses a separate credential entry from the transcription key.

The file-adapter credential tests remove legacy plaintext only after a protected write and successful readback verification. Production PostgreSQL import verifies ciphertext before committing, omits credential fields from JSONB and deliberately preserves original migration sources. Failed import rolls back without discarding the original credential. Bootstrap environment files and old backups are not rewritten as encrypted artifacts by these tests.
