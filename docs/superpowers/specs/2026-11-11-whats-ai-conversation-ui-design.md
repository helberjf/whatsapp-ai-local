# Whats AI Conversation UI Design

## Objective

Make the Whats AI conversation experience denser and closer to WhatsApp while preserving CRM, AI, automation, account separation, local privacy, and existing data. The work covers unread indicators, dashboard density, contact media, profile-photo viewing, group organization, audio transcription timing, and dark-theme select readability.

## Confirmed behavior

### Unread title and removed totals

- The browser title is `(N) Whats AI` when `N` is the sum of unread messages across the active account.
- The title is `Whats AI` when that sum is zero.
- The title never shows total conversations.
- The `Todas` filter and the `Conversas` navigation entry do not show the total number of conversations.
- The dashboard card that only reports the total number of conversations is removed.

### Compact dashboard cards

- Remaining cards use a smaller height and tighter spacing.
- Each card displays its numeric value and label on one line.
- Existing colors, icons, meanings, and click behavior remain intact.
- The layout must remain readable at desktop and narrow mobile widths.

### Contact photo and media panel

- Clicking the round avatar opens the profile photo in the existing media viewer at the largest safe available size.
- If the profile image is unavailable, the avatar keeps the contact initials and an explanatory notice is shown.
- Clicking the contact name or conversation header opens a WhatsApp-like side panel while keeping the conversation visible.
- The side panel keeps the existing contact data and CRM actions, then adds a `Mídia, links e documentos` section.
- The first media items appear as a compact preview grid. `Ver tudo` opens the complete paginated gallery.
- The gallery contains images and videos sent or received in that conversation. Clicking an item opens it with the existing protected media viewer.
- Media bytes and thumbnails load only when needed. Private media is not placed in the PWA shell cache.
- Removed or unavailable media produces an inline unavailable state without closing the gallery.

### Group ordering and pinning

- Group ordering is independent per WhatsApp account and persists across restarts.
- Groups can be reordered by drag and drop.
- A small hamburger menu on each group provides `Fixar grupo` or `Desafixar grupo`.
- Pinned groups form the first block in the group list.
- Fixing a group inserts it at the first position of the pinned block.
- Users can subsequently drag groups inside the pinned block or inside the normal block.
- Dragging cannot silently change pin state: crossing the boundary is rejected visually, and pinning remains an explicit menu action.
- A newly discovered group is appended to the normal block using the existing recent-message order until the user reorders it.
- If persistence fails, the UI restores the previous order and shows a non-destructive error notice.

### Transcription timing

- Background scanning of every conversation for new audio is removed.
- Opening an individual conversation considers only the five most recent audio messages in that conversation. Among those five, each audio that has no completed, running, or queued transcription is enqueued once.
- Loading older pages does not automatically enqueue additional audio. Audio outside the five-most-recent window remains available through an explicit `Transcrever áudio` action in its hamburger menu.
- Existing transcription deduplication remains the source of truth, so repeated opens never create duplicate jobs.
- Group conversations never enqueue transcription automatically.
- A group audio exposes a `Transcrever áudio` action in its hamburger menu. The action enqueues only that message and then shows queued, running, completed, or failed state normally.
- Individual audio outside the automatic five-message window exposes the same `Transcrever áudio` action and enqueues only the selected message.
- Existing priority and retry behavior remains available where relevant.

### Dark-theme select readability

- Native `select` controls and their `option` rows use opaque backgrounds and high-contrast text in the dark theme.
- Hover, selected, disabled, and focus states remain distinguishable.
- The fix applies to existing select controls rather than a custom dropdown replacement.

## Architecture

### Frontend responsibilities

- The existing chat list remains the source for unread values and drives a small title updater.
- Dashboard rendering omits the conversation-total metric and uses compact CSS variants for the remaining cards.
- Contact header and avatar clicks are separate explicit targets.
- A focused contact-media module manages the side panel, paginated gallery, lazy media previews, and viewer handoff instead of adding more unrelated state to `public/app.js`.
- A focused group-order module manages drag state, pinned boundaries, optimistic rendering, rollback, and persistence calls.
- Conversation selection requests discovery only after an individual chat is open and limits automatic discovery to its five most recent audio messages; older individual audio and all group audio remain per-message controls.

### Server responsibilities

- Group presentation state is stored in the existing per-account application store as a versioned structure containing pinned IDs and ordered IDs. Unknown or removed groups are reconciled without deleting stored preferences prematurely.
- A small authenticated endpoint reads and updates the active account's group presentation state. It validates JIDs, uniqueness, block membership, and maximum list size.
- A paginated authenticated media endpoint returns only safe metadata for image and video messages belonging to the requested conversation. Existing `/api/media` remains responsible for loading bytes for a selected item.
- The first message-page request for an opened individual conversation invokes transcription discovery with at most the five most recent audio messages. Older pages and group pages do not invoke automatic discovery.
- The periodic background audio discovery loop is removed, while transcription workers and explicit enqueue routes remain unchanged.

## Data model

Per-account group preferences use this logical shape:

```json
{
  "groupPresentation": {
    "version": 1,
    "pinned": ["group-a@g.us", "group-b@g.us"],
    "normal": ["group-c@g.us", "group-d@g.us"]
  }
}
```

The first item in `pinned` is the first pinned group shown. Fixing a group removes it from both arrays and inserts it at the start of `pinned`. Unfixing removes it from `pinned` and inserts it at the start of `normal`. Drag operations only reorder items within their current array.

The media gallery response contains pagination plus message metadata already authorized for the selected conversation. It does not contain raw connector secrets, arbitrary URLs, or media bytes.

## Error handling and privacy

- All new endpoints use the existing local session token and active-account selection.
- Conversation and group identifiers pass existing JID validation.
- Media requests are restricted to records returned by the connector for the requested conversation.
- Failed group preference writes return the prior UI state through optimistic rollback.
- Aborted conversation changes cancel stale gallery and avatar work where possible.
- Media object URLs continue to use the existing bounded cache and are revoked when released.
- The service worker continues to ignore `/api/` requests, so conversations, gallery data, and media never enter the PWA cache.

## Testing strategy

- Unit/frontend tests verify unread-title formatting, zero-title behavior, removed totals, compact metric markup, distinct avatar/header actions, select contrast classes, gallery pagination, and stale-request cancellation.
- Server tests verify authenticated per-account group order, last-fixed-first insertion, reorder validation, rollback-compatible failures, gallery filtering, pagination, and rejection of invalid JIDs.
- Transcription tests verify that closed chats do not enqueue work, opening an individual chat discovers at most the five most recent audio messages once, older pages do not enqueue automatically, older individual audio can be requested explicitly, and groups require explicit enqueue.
- End-to-end tests verify the compact dashboard at desktop and mobile widths, profile-photo viewing, contact gallery navigation, drag ordering after reload, pin/unpin ordering, group manual transcription, and opaque dropdown options.
- The complete Node test suite and relevant Playwright suites run before integration.

## Out of scope

- Rebuilding the application as a pixel-for-pixel WhatsApp Web clone.
- Importing historical media that the local connector does not possess.
- Automatic transcription of group audio.
- Changing CRM, AI provider, automation, account-pairing, or media retention behavior beyond the interactions described here.
