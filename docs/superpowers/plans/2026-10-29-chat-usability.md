# Chat interaction fixes

- Diagnose the reported video with technical metadata and an isolated browser. The sampled MP4 is valid H.264/AAC and plays through native controls; no transcoding is warranted. Make the explicit video action start playback, preserve the player across refreshes, and avoid starting an old chat's video after selection changes.
- Use a native top-layer popover for message actions, clamped to the visible conversation. Close it on outside click, Escape, scrolling, rerender or resize so short incoming bubbles and the last message cannot clip the actions.
- Replace the separate attachment/sticker icons with one attachment dialog. Keep photo/video, audio, document and sticker choices; preserve an explicit document selection even for image/video files.
- Send on Enter. Keep Shift+Enter for line breaks and do not submit repeated or composition/IME key events.
- Generate manual AI suggestions from the selected conversation's most recent sent and received text, bounded to 14 messages and 12,000 characters. Preserve automatic-reply eligibility, rules and deduplication.
- Guard delayed suggestions with selection, draft revision and message snapshots; allow sufficient time for local CPU inference without inserting a result into another chat.
- Verify behavior with domain tests and browser flows using fictional contacts. Never send or delete real WhatsApp messages for QA, and do not record real video frames or personal conversation content.
