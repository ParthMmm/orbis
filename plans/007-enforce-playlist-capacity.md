# Plan 007: Keep membership capacity consistent across both write routes

> **Executor instructions:** Read fully, follow the steps, and run every verification gate. Stop on the conditions below instead of improvising. Update this plan's status row in `plans/README.md` when execution ends.
>
> **Drift check (run first):** `git diff --stat 8cc79af..HEAD -- apps/server/src/library-limits.ts apps/server/src/app.ts apps/server/src/library.ts apps/server/src/library.test.ts docs/specs/first-library-slice.md plans/README.md` and `git diff --stat -- apps/server/src/library-limits.ts apps/server/src/app.ts apps/server/src/library.ts apps/server/src/library.test.ts docs/specs/first-library-slice.md plans/README.md`. Compare the live code with the current-state excerpts; uncommitted changes matter too. Expected predecessor edits are allowed only as described below. Unexplained semantic drift means STOP.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW — transactional validation with no automatic trimming of existing data
- **Depends on:** none; execute after 006 to avoid overlapping edits to `library.ts`
- **Category:** bug
- **Audit finding:** 7; high confidence, 501-member state and rejected resubmission reproduced in memory
- **Planned at:** commit `8cc79af`, 2026-09-11 (Mac local date), working-tree audit

## Scope

**In scope — only these files may change:**

- `apps/server/src/library-limits.ts`
- `apps/server/src/app.ts`
- `apps/server/src/library.ts`
- `apps/server/src/library.test.ts`
- `docs/specs/first-library-slice.md`

`plans/README.md` may also change, only for this plan's status. Preserve pre-existing changes; evaluate the executor-created diff against its recorded start state.

## Git workflow

Use an owner-approved isolated checkout, one writer per checkout. Suggested branch: `advisor/007-enforce-playlist-capacity`. Do not stash, reset, or overwrite concurrent work. Do not install, commit, push, or open a PR without separate permission. Existing messages use conventional commits, for example `fix(app): ask before forgetting the device`.

## Why this matters

The API limits a Playlist replacement body to 500 Sets, but a Set-centric membership update can append a 501st Set to that Playlist. The server then returns a list that its own replacement endpoint rejects. The inverse path can also create more than 100 Playlist memberships for one Set. Enforce both existing capacities at the transaction boundary so alternate endpoints cannot create states that their full-list APIs cannot express.

## Current state

- `apps/server/src/app.ts:179–185` validates `setIds` with `Schema.isMaxLength(500)` for `PUT /playlists/:id/sets`.
- `app.ts:201–207` validates `playlistIds` with `Schema.isMaxLength(100)` for `PUT /sets/:id/playlists`.
- These are different dimensions. **Do not replace them with one equal cap.** A Playlist can contain 500 Sets while one Set can belong to 100 Playlists.
- `library.ts:432–461`, `setPlaylistMembers`, validates duplicates/existence in a synchronous `db.transaction`, deletes membership rows for that Playlist, inserts the replacement in order, then lists it.
- `library.ts:470–517`, `setPlaylistMemberships`, validates duplicates/existence, removes memberships not listed, and appends missing memberships with:
  ```sql
  INSERT OR IGNORE INTO playlist_sets VALUES (?, ?, ?)
  ```
  There is no capacity check on the opposite side of either operation.
- `library.test.ts:474–489` checks that an invalid duplicate Playlist replacement leaves order unchanged. The Set-centric error cases at 572–589 do not assert rollback of a pre-existing membership.
- The audit created 501 titled Sets in an in-memory app, filled a Playlist with the first 500, and added the last Set through the Set-centric route. Results: fill 200, extra membership 200, list size 501, resubmission 400. No provider call or live database was involved.
- `docs/specs/first-library-slice.md` says: “A set can belong to multiple playlists.” Its HTTP-boundary testing rule calls for real temporary SQLite storage, not mocked internals. Add the concrete capacities without rewriting historical scope sections.
- `CONTEXT.md`: a Playlist is “A named, ordered selection of Sets from the Library.” Removing membership never deletes a Set.

`app.ts` was already dirty with logging simplification/lazy registry reads; preserve them. Plan 001 may add an authentication mode, and 006 may add a schema-version-2 reverse index. These are expected predecessor changes and must remain intact; no other mutation behavior drift is assumed.

## Commands you will need

| Purpose | Command | Expected result |
| --- | --- | --- |
| Library HTTP tests | `bun test apps/server/src/library.test.ts` | All pass after the fix |
| Server suite | `bun test apps/server/src` | All pass |
| Full JS/TS gates | `bun run check:force` | Exit 0; no diagnostics |
| Whitespace | `git diff --check` | Exit 0 |

Use Bun 1.4.1. Before Effect edits, run `effect-solutions list` and `effect-solutions show basics error-handling services-and-layers testing`, then confirm APIs against the installed Effect 4.0.0-rc.113 source in `apps/server/node_modules/effect/src`. Match this repository's `bun:test` and `LibraryError` patterns; do not install a new test framework.

## Out of scope

No new client features, shared-contract extraction, limit increases, pagination, membership merging across clients, automatic cleanup of oversized existing Playlists, database schema change, server-wide body-limit change, or generic validation-error redesign. The concurrent Raycast/source-URL work in `packages/contracts` is explicitly excluded. Plan 006 owns indexes; do not recreate its work here.

## Steps

### Step 1: Name the two capacities without changing behavior

Create `apps/server/src/library-limits.ts` exporting `MAX_SETS_PER_PLAYLIST = 500` and `MAX_PLAYLISTS_PER_SET = 100`. Use these constants for the two HTTP array limits in `app.ts`, leaving identifier-length validation unchanged. Keep the constants server-local; this fix does not require changing a concurrent shared-contract package.

Add explicit boundary tests for the request shapes, including 500 versus 501 Set IDs and 100 versus 101 Playlist IDs. Match existing `request(createApp(...), ...)` integration patterns and dispose temporary apps. Use valid unique IDs/existing fixture records when testing success, not nonexistent IDs that would fail for a different reason.

**Verify:** `bun test apps/server/src/library.test.ts` → existing tests and the HTTP cap boundary cases pass. `git diff --check` → exit 0.

### Step 2: Validate complete membership transitions inside transactions

Import both constants into `library.ts`. Enforce each operation's own full-list maximum at the service boundary too, so internal callers cannot bypass HTTP validation. Use `LibraryError` with status 400 and a clear capacity message, matching existing duplicate/missing errors.

Inside `setPlaylistMemberships`' transaction, after duplicate/existence checks and before deleting/inserting anything, identify genuinely new `(playlistId, setId)` pairs. For each newly joined Playlist, count current members and reject if adding this Set would exceed 500. Retaining an existing membership in a full Playlist must succeed; do not count it as an append.

Inside `setPlaylistMembers`' transaction, similarly identify Sets newly joining this Playlist. For each, count current Playlist memberships and reject if adding this Playlist would exceed 100. Retained members at the limit must not block a reorder. A replacement list still cannot exceed 500.

Perform all reads/validation/writes in the existing synchronous SQLite transaction, not in an HTTP preflight or an awaited loop. Preserve missing/duplicate behavior, ordering, and atomicity. Validate every proposed addition before destructive changes; a failure must not remove old memberships or alter any other Playlist's positions.

Add regression tests for the reproduced 501st-member append and the inverse 101st-Playlist addition. Each now returns 400 and leaves the pre-request data intact. Include a failed move from one Playlist to another full Playlist: the source membership must survive.

**Verify:** `bun test apps/server/src/library.test.ts` → both alternate-route bypass cases reject with 400 and rollback assertions pass; ordinary add/reorder/remove cases remain green.

### Step 3: Prove idempotence and recovery for previously oversized data

Add tests for keeping an existing membership at capacity, reordering a full Playlist, removing membership, and retrying a valid unchanged request. Cover a multi-destination change in which one destination is full; no partial joins/leaves may persist. Assert no Library Set is deleted by membership removal.

Model an already oversized database using a temporary file-backed fixture initialized by the app and explicitly seeded through `bun:sqlite`, never by weakening the fixed endpoints. Reads must continue to work. Allow removing memberships or replacing a list with a valid-size list to recover. Reject additional growth through either route. Do not silently trim existing records, reject startup, or require a data migration. A list still above its own HTTP cap must be reduced to the cap in one full-list request or through opposite-direction removals; do not promise arbitrary oversized full-list resubmission will work.

Use bounded fixtures; if HTTP seeding of 500+ records exceeds Bun's default timeout, give only the affected fixture-heavy tests an explicit 30-second timeout or seed their isolated database directly. Do not use timing assertions or increase the whole-suite timeout.

**Verify:** `bun test apps/server/src/library.test.ts apps/server/src/migration.test.ts` → all pass, including unchanged-at-capacity, atomic failure, removal, and oversized-data recovery.

### Step 4: State the limits and run final gates

Add a short capacity paragraph next to Playlist behavior in `docs/specs/first-library-slice.md`: 500 Sets per Playlist, 100 Playlists per Set, full-list APIs, atomic rejection on excess, and no automatic deletion of pre-existing over-limit data. Preserve the distinction between an ordered Playlist and the whole Library.

**Verify:** `bun run check:force && git diff --check` → exit 0. `git status --short` → no executor-created changes outside Scope; no shared-contract or Raycast edits.

## Test plan

Test exact boundary successes and rejections in both dimensions, both cross-route additions, unchanged memberships at capacity, reorder/removal, rollback across multiple destinations, missing/duplicate IDs, and recovery of seeded pre-existing oversized state. Follow the duplicate-member rollback test's before/after HTTP assertions. Use real in-memory or disposable file-backed SQLite, no live Library and no metadata network calls (give saved fixtures explicit titles).

## Done criteria

- [ ] Both dimensions have separate constants used by HTTP and service validation.
- [ ] Neither route can create new over-capacity membership state.
- [ ] No-op, retain, reorder, and removal at capacity remain valid.
- [ ] Failed multi-membership transitions preserve all previous memberships and order.
- [ ] Existing oversized data remains readable and reducible without automatic trimming.
- [ ] Library/migration/server tests, full JS/TS checks, and whitespace gate exit 0.
- [ ] Scope respected and index status updated.

## STOP conditions

Stop if the owner intends these values as body-size limits only and wants unbounded relationship sizes; that requires a different API design, not silently raising caps. Stop on unexpected transaction/schema drift, a need to edit clients/shared contracts, two failed verification attempts, or any suggestion to trim a real database. If another writer has changed the limits, reconcile rather than enforcing stale values.

## Maintenance notes

Both mutation directions must preserve the same two relationship invariants. Review checks for new versus retained pairs, and ensure validation happens inside the transaction. Large existing data is not a reason to delete records or weaken the cap; retain explicit read/recovery behavior. Future bulk APIs need the same service-level checks.
