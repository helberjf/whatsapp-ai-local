# Local AI start button

The Assistant page now has an Ollama control that checks the local runtime, starts an installed executable without a console window when necessary, preloads the installed selected model, and saves the local provider only after readiness is confirmed.

- The API requires the existing session token and uses a fixed loopback origin; remote addresses, credentials in URLs and arbitrary process arguments are rejected.
- Starting a model is single-flight. Missing runtimes/models produce a clear message and never trigger installation or model downloads.
- Status requests never start processes or change settings. Loading sends no user prompt, contact, document or message content.
- An explicit CPU option handles GPU memory shortages. The preference is stored in public provider metadata and used on subsequent Ollama chat requests.
- Existing automatic-reply switches, audiences, CRM, credentials and WhatsApp pairing are preserved.
- Backend tests cover validation, startup, duplicate clicks, model loading, safe errors, CPU execution and HTTP authentication/configuration. UI regressions cover already-loaded unsaved providers and preserve the automatic-reply switch.
- Playwright verifies the start control and CPU option against an isolated runtime fixture. Documentation capture is explicit through `WHATSAPP_CAPTURE_DOCS=1`; normal tests save screenshots under ignored test results.
- Live validation loads `qwen2.5:7b` with an empty request. This machine reported GPU allocation failure, then successfully confirmed CPU execution without sending any WhatsApp test message.
