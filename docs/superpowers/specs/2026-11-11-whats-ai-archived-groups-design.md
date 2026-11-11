# Whats AI Archived Groups Design

## Objective

Add a persistent `Grupos arquivados` folder inside the existing Groups view. Archiving is managed by Whats AI, remains independent from private-conversation archiving, and never affects the browser unread title or private-conversation unread metrics.

## Confirmed behavior

- The `Grupos arquivados` folder appears only after the user enters `Grupos`.
- Opening the folder replaces the active group list with archived groups and provides a clear `← Voltar aos grupos` action.
- A new message never removes a group from the archived folder.
- Archived groups do not contribute to the browser title, `Não lidas`, conversation navigation counts, or any private-conversation metric.
- The folder row does not show an unread badge. Individual archived group rows may still display their own unread indicator so the user can see activity after opening the folder.
- Group archive state is local to the active WhatsApp account and persists across browser reloads and application restarts.

## Group menu and ordering

- The hamburger on a group row opens a small accessible menu instead of immediately toggling the pinned state.
- An active group menu contains `Fixar grupo` or `Desafixar grupo`, plus `Arquivar grupo`.
- An archived group menu contains `Desarquivar grupo`. It does not offer pinning while archived.
- Archiving removes the group from both active ordering blocks and inserts it first in the archived block.
- If the group was pinned, archiving also clears its pinned state.
- Desarchiving inserts the group first in the normal, unpinned block.
- The last group fixed remains first in the pinned block.
- Drag and drop reorders groups only inside the currently visible block: pinned, normal, or archived. Dragging cannot pin, unpin, archive, or desarchive a group.
- Clicking outside the menu or pressing Escape closes it without changing state.

## Architecture

### Presentation service

The existing per-account `groupPresentation` service remains the single source of truth. Its versioned state gains an `archived` array and explicit archive mutation. Version 1 state migrates in memory to version 2 with an empty archived block.

The service exposes operations to:

- read and reconcile known groups;
- pin or unpin an active group;
- archive or desarchive one group;
- reorder a block without changing membership.

All mutations validate group JIDs, uniqueness, block separation, and the existing maximum group limit. A group may exist in exactly one block. Reconciliation appends newly discovered groups to `normal`. Archived identifiers are retained when a group is temporarily absent from the connector so it does not reappear as active after a later sync.

### Server routes

- `GET /api/group-presentation` returns reconciled version 2 state for all groups returned by the inbox source.
- `PUT /api/group-presentation` persists the order of the three blocks without allowing membership changes.
- `PATCH /api/group-presentation/pin` keeps the current explicit pin behavior for active groups and rejects archived groups.
- `PATCH /api/group-presentation/archive` accepts a valid group JID and boolean `archived` value, then atomically moves the group to the correct block.

All routes use the existing local session token and active-account header, so accounts cannot share group preferences.

### Frontend

`public/group-order.js` owns the group menu, optimistic state changes, drag state, rollback, and the archived-folder mode. `public/app.js` only asks the module which groups are visible and renders the folder navigation row.

The filter states are explicit:

- `groups`: pinned and normal active groups;
- `groups-archived`: archived groups only;
- empty: private conversations.

The existing group menu button receives `aria-expanded` and `aria-haspopup="menu"`. Menu items are keyboard reachable, and focus returns to the hamburger after the menu closes.

## Data model

```json
{
  "groupPresentation": {
    "version": 2,
    "pinned": ["group-a@g.us"],
    "normal": ["group-b@g.us", "group-c@g.us"],
    "archived": ["group-d@g.us"]
  }
}
```

Each group ID appears in exactly one array. Array order is display order. Archive and desarchive operations are membership changes and therefore use their dedicated route; ordinary reorder requests cannot move IDs between arrays.

## Error handling

- Frontend mutations are optimistic, but any failed request restores the complete previous state and shows the existing non-destructive notice.
- Invalid or duplicated IDs return validation errors without altering stored state.
- Concurrent stale reorder requests return a conflict and prompt the UI to refresh its presentation state.
- A temporarily unavailable archived group remains stored but is omitted from the visible folder until the connector reports it again.
- No WhatsApp-native archive request is sent, so private conversation archive settings and the phone's `Manter conversas arquivadas` preference are unaffected.

## Testing strategy

- Service tests cover version 1 migration, archive-first insertion, pinned-state removal, desarchive-to-normal insertion, block uniqueness, temporary absence, and reorder validation for all three blocks.
- Server tests verify authenticated per-account routes and confirm reconciliation uses the inbox source that includes groups.
- Frontend tests verify menu actions, Escape/outside dismissal, optimistic rollback, folder filtering, and unread-metric isolation.
- End-to-end tests archive a pinned group, reload, open `Grupos arquivados`, verify persistence, desarchive it, and confirm the browser title and private unread metric never change because of group unread counts.
- The full Node suite and the relevant Playwright workspace suite run before integration.

## Out of scope

- Archiving or desarchiving the group in WhatsApp on the phone.
- Automatically desarchiving a group after a new message.
- Mixing private conversations into the group archive folder.
- Bulk group archive actions.
