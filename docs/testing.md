# Testing and validation

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

The browser suite starts its own fixture environment. It exercises the real browser interface and application HTTP routes while replacing WhatsApp and AI network boundaries. Keep production services on their normal ports; the browser fixture is independent.

Test totals can change as coverage grows. Use the command's final pass/fail/skip summary as the current result rather than a historical count in documentation.

## Coverage map

| Area | What the tests establish |
| --- | --- |
| HTTP boundary | Request validation, session token, origin/host checks, response contracts, and rejected malformed operations. |
| Connector adapter | Evolution request shapes, message normalization, private identifiers, contact names, profile availability, media behavior, and error handling. |
| Sending and forwarding | Explicit requests, draft preservation, stable request identifiers, and conservative handling of uncertain sends. |
| Scheduling | Persisted jobs, due time conversion, cancellation and editing restrictions, disconnect grace period, restart recovery, and no automatic repeat of uncertain sends. |
| Triggers | First-contact, keyword, business hours, inactivity, delays, ordered response sequences, master switch behavior, cooldowns, and coordination with other reply workers. |
| Assistant | Audience eligibility, opt-in boundaries, explicit contact overrides, pause/rate limits, handoff behavior, and late-response invalidation. |
| Frontend state | Safe text rendering, preserved composer changes, media element continuity, pagination, explicit save/cancel actions, and duplicate-click protection. |
| Native message actions | Delete-for-everyone validation, polls, sticker input checks, disappearing-message capability negotiation, extension state, and rejected unconfirmed connector replies. |
| Knowledge and products | Document extraction, lexical retrieval, catalog validation, supported import formats, and source-backed answer preparation. |
| Transcription | Queue limits, retries, local/cloud selection, temporary file cleanup, persisted results, and controlled engine/provider failures. |
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

Legacy plaintext is removed only after a protected write and successful readback verification. A failed migration deliberately leaves the original JSON key intact and returns an error; the application does not silently discard the only usable credential. These tests do not encrypt connector environment files or rewrite old backups.
