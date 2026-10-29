# Conversation space and media implementation plan

**Goal:** Rename the visible app to Whats AI, enlarge conversations, move global search to the sidebar, record voice messages, and preview images/PDFs without leaving the app.

**Architecture:** Keep the existing local Node server and sending routes. Add a focused browser media controller for microphone lifecycle and the attachment viewer, plus a locally served PDF.js canvas reader. Keep stable storage, credential, connector, and integration identifiers unchanged. Remove redundant header cards; show contact/CRM tools in a closable overlay.

**Tech stack:** Browser JavaScript, CSS, MediaRecorder, native dialog, Node HTTP, Playwright.

- [x] Add browser regression cases for voice recording/review/cancel, inline image and PDF viewing, sidebar search, and wider conversations. Run the new cases and confirm the missing behavior.
- [x] Add fictional image/PDF fixtures to the isolated demo. Continue using isolated stores and never send tests to personal contacts.
- [x] Implement microphone permission/error handling, stop/cancel, preview, 5-minute/10-MB limits, track cleanup, and selection guards. Reuse the explicit send action and existing audio attachment route.
- [x] Add an attachment viewer with image zoom, PDF page/zoom controls, download and close. Verify PDF/raster signatures and render PDFs locally using PDF.js. Keep frames and plugin objects blocked in CSP; serve only the required library assets and worker.
- [x] Replace the header with a sidebar search dialog and keep connection/AI settings in their existing navigation destinations. Expand the conversation column and make CRM an overlay. Verify controls at desktop, short-window, and mobile sizes.
- [x] Rename public branding and owned desktop shortcuts to Whats AI. Preserve existing auto-start preference and all persistent identifiers.
- [x] Run Node and Playwright suites, inspect refreshed fictional documentation screenshots, update the English README/testing notes, check the running local app, and commit the verified changes.
