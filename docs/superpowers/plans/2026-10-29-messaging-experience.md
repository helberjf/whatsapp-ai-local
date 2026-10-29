# Messaging experience implementation plan

> For agentic workers: use test-driven development and verify each independent change before integration.

**Goal:** Improve the existing personal WhatsApp workspace, add opt-in reply audiences and triggers, and provide an English portfolio README with privacy-safe screenshots.

**Architecture:** Retain the current Node HTTP application and Evolution 2.3.7 connection. Extend focused services and expose capabilities truthfully. Real account data and pairing remain untouched by test fixtures.

**Tech stack:** Node.js 22, vanilla browser JavaScript, SQLite/JSON persistence, Docker, Playwright Test.

- [x] Audit current browser layout before edits; record clipping at desktop, laptop and mobile widths.
- [x] Add isolated, fictional demo fixtures and repeatable Playwright flows. Test button reachability, dialogs, draft preservation and media interaction.
- [x] Improve audio/video cards and safe clickable HTTP(S) links; retain media elements while polling.
- [x] Add emoji insertion, explicit sticker attachment mode, contact details and confirmed message deletion. Validate connector methods against official versioned source.
- [x] Determine connector support for genuine disappearing messages; expose supported options with accurate capability reporting rather than a simulated delete timer.
- [x] Extend AI audience to classified/all/new, preserving explicit off/pause choices, fresh-message gates and send limits.
- [x] Implement persistent first-contact, keyword and absence triggers with configurable hours, delays and sequences; coordinate claims to avoid competing replies.
- [x] Integrate reference-style trigger UI with a reachable save footer and narrow-screen layout.
- [x] Run unit/HTTP and Playwright suites, review failures and inspect screenshots.
- [x] Replace README with an English overview, architecture, setup, security, feature behavior, test evidence and fictional screenshot gallery.
- [x] Review diff for account data and regressions, commit only implementation/docs assets and leave the app ready.

## Acceptance details

New automatic response features default to off. Tests must never send to real contacts, enable the user's real automation settings or delete real messages. Incoming individual messages only are eligible. Claims are saved before processing; uncertain sends are not retried automatically. New-contact eligibility relies on conversation history rather than an address-book name.

The portfolio screenshots use the real application against an isolated connector with fictional contacts, sample documents and generated media. Screenshot captions identify these fixtures. The README must distinguish BM25 retrieval from semantic embeddings and document provider credential storage as actually implemented.
