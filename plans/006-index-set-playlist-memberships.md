# Plan 006: Index playlist membership lookup by Set

> **Executor instructions:** Read fully, follow the steps, and run every verification gate. Stop on the conditions below instead of improvising. Update this plan's status row in `plans/README.md` when execution ends.
>
> **Drift check (run first):** `git diff --stat 8cc79af..HEAD -- apps/server/src/library.ts apps/server/src/migration.test.ts plans/README.md` and `git diff --stat -- apps/server/src/library.ts apps/server/src/migration.test.ts plans/README.md`. Compare the live code with the current-state excerpts; uncommitted changes matter too. Expected predecessor edits are allowed only as described below. Unexplained semantic drift means STOP.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW — additive index migration; data and HTTP responses stay unchanged
- **Depends on:** none; run before 007 or serialize their shared `library.ts` edits
- **Category:** perf
- **Audit finding:** 6; high confidence from in-memory SQLite query plans
- **Planned at:** commit `8cc79af`, 2026-09-11 (Mac local date), working-tree audit

## Scope

**In scope — only these files may change:**

- `apps/server/src/library.ts`
- `apps/server/src/migration.test.ts`

`plans/README.md` may also change, only for this plan's status. Preserve pre-existing changes; evaluate the executor-created diff against its recorded start state.

## Git workflow

Use an owner-approved isolated checkout, one writer per checkout. Suggested branch: `advisor/006-index-set-playlist-memberships`. Do not stash, reset, or overwrite concurrent work. Do not install, commit, push, or open a PR without separate permission. Existing messages use conventional commits, for example `fix(app): ask before forgetting the device`.

## Why this matters

Every returned Set computes its playlist IDs with a correlated membership lookup. The table has no index starting with `set_id`, so listing N Sets with M membership rows performs roughly N scans of M rows. A small reverse index avoids this growth without introducing pagination or changing the API. Existing databases need the index too, not only newly created ones.

## Current state

`apps/server/src/library.ts:22–31` defines the common `SET_COLUMNS` used by reads and mutation responses. Its membership expression is:

```sql
(SELECT COALESCE(json_group_array(playlist_id ORDER BY playlist_id), '[]')
 FROM playlist_sets WHERE playlist_sets.set_id = sets.id) AS playlistIds
```

`library.ts:53–56` defines:

```sql
CREATE TABLE IF NOT EXISTS playlist_sets (
 playlist_id TEXT NOT NULL REFERENCES playlists(id), set_id TEXT NOT NULL REFERENCES sets(id), position INTEGER NOT NULL,
 PRIMARY KEY (playlist_id, set_id), UNIQUE (playlist_id, position)
);
```

`CURRENT_SCHEMA_VERSION` is 1. `ensureSchema` executes `CREATE_SCHEMA` and sets the version for a fresh database; existing databases run `MIGRATIONS[step - 1]` from their version to the current version. Appending SQL to a version-1 migration alone will not update databases already at version 1.

The audited in-memory `EXPLAIN QUERY PLAN` for the actual Set projection included `SCAN playlist_sets USING COVERING INDEX sqlite_autoindex_playlist_sets_1`. Adding an index on `set_id` changed that operation to `SEARCH playlist_sets USING INDEX ... (set_id=?)`. This proves the access-path defect; no live-library latency benchmark was run. Do not claim measured user-visible speedup.

`migration.test.ts` creates a temporary legacy database, initializes it through `createApp({ databasePath })`, makes HTTP requests, disposes the app, and removes the temp directory in `finally`. Match that pattern. `CONTEXT.md`: “Playlist: A named, ordered selection of Sets from the Library.” Preserve both Playlist order and the sorted `playlistIds` response representation.

## Commands you will need

| Purpose | Command | Expected result |
| --- | --- | --- |
| Migration tests | `bun test apps/server/src/migration.test.ts` | All pass |
| Server suite | `bun test apps/server/src` | All pass |
| Full existing JS/TS gates | `bun run check:force` | Exit 0; no diagnostics |
| Whitespace | `git diff --check` | Exit 0 |

Use Bun 1.4.1 and the existing `bun:test` setup. Before any Effect changes, run `effect-solutions list` and `effect-solutions show basics services-and-layers testing`; confirm APIs in `apps/server/node_modules/effect/src` or the local Effect source checkout. Generic guide examples are not permission to replace Bun tests with Vitest. No dependency installation is needed.

## Out of scope

No data deletion/reordering, response changes, pagination, search index, tag normalization, query batching, database abstraction, broad migration-framework rewrite, or capacity-rule change. Do not modify shared contracts, Raycast, deployment settings, or the owner's live SQLite database. Plan 007 owns membership capacity validation.

## Steps

### Step 1: Confirm the baseline and query-plan evidence

Run drift and migration tests. Inspect `SET_COLUMNS`, table/index definitions, `CURRENT_SCHEMA_VERSION`, and every migration. If another migration has landed, stop and rebase the plan rather than reusing its version number. Retain the fresh/version-0/version-1 distinction in the tests below.

**Verify:** `bun test apps/server/src/migration.test.ts` → existing migration tests pass. `rg -n 'CURRENT_SCHEMA_VERSION|CREATE INDEX|MIGRATIONS' apps/server/src/library.ts` → version 1 and no reverse membership index at the planning baseline. A pre-existing equivalent index means report the finding as independently fixed, not add a duplicate.

### Step 2: Add one idempotent index through both creation paths

Define one SQL statement for `CREATE INDEX IF NOT EXISTS playlist_sets_by_set ON playlist_sets(set_id, playlist_id)`. The leading Set ID permits lookup; the second column covers the returned Playlist IDs. Reuse that statement in `CREATE_SCHEMA` after `playlist_sets` exists and as the new version-2 migration. Increase `CURRENT_SCHEMA_VERSION` to 2. Do not edit the version-1 migration or change existing column defaults. Do not add the index only to the new-database path or unconditionally assume startup creates tables again for existing databases.

Add tests in `migration.test.ts` for a fresh database and a frozen version-1 fixture with the full version-1 columns but no reverse index. Populate Sets, Playlists, and positions in the fixture. Initialize through a harmless HTTP read; then inspect `PRAGMA user_version`, `PRAGMA index_list('playlist_sets')`, and `PRAGMA index_info('playlist_sets_by_set')` through a separate temporary-database connection. Expect version 2 and the named reverse index to be present. `index_list` also contains the existing primary-key and position-uniqueness autoindexes: do not assert that the table has only one index. `index_info('playlist_sets_by_set')`, specifically, must report exactly the two ordered columns `set_id`, `playlist_id`.

**Verify:** `bun test apps/server/src/migration.test.ts` → old legacy migration tests plus fresh/version-1 index tests pass. No user data is read or modified.

### Step 3: Prove idempotence, preservation, and indexed access

Extend tests to cover version 0 → 2, version 1 → 2, closing/reopening version 2, and the new index already existing at version 1. Every case must preserve Set metadata, membership count, and per-Playlist order. Verify that reopens do not add duplicate indexes or alter version-1 title ownership semantics.

Add an `EXPLAIN QUERY PLAN` assertion on a correlated lookup matching the actual `SET_COLUMNS` membership expression. Check for a `SEARCH` on the named reverse index and absence of a full `SCAN playlist_sets` in that subquery. Do not snapshot the entire planner output: SQLite may change unrelated sort/B-tree wording. If the optimizer selects an equivalent valid reverse index after drift, stop to reconcile rather than forcing a redundant index.

**Verify:** `bun test apps/server/src/migration.test.ts apps/server/src/library.test.ts` → all pass, including the reopen and query-plan cases. `bun run check:force && git diff --check` → exit 0.

## Test plan

Use file-backed temporary databases so index metadata can be inspected without exporting private production SQL constants solely for tests. Construct the version-1 fixture from a fixed schema snapshot, not by calling the current creator and assuming it represents old state. Close all database handles before removing the temp directory. Assert index columns/query shape rather than timing; no benchmark threshold is needed for this fix.

## Done criteria

- [ ] Fresh, version-0, and version-1 databases all end at version 2 with one correct reverse index.
- [ ] Reopen and pre-existing-index scenarios pass without loss or duplicate indexes.
- [ ] Existing Set data, Playlist order, response shape, and title ownership tests remain unchanged and pass.
- [ ] The correlated lookup uses indexed SEARCH rather than a full membership-table scan.
- [ ] Migration/server tests, full JS/TS checks, and whitespace gate exit 0.
- [ ] Scope respected and index status updated.

## STOP conditions

Stop if the schema version has advanced unexpectedly, the equivalent index already exists, migration tests require a live database, or a change to migration infrastructure/API output becomes necessary. Stop for two failed verification attempts or missing dependencies. Never delete/recreate the database to make a migration pass.

## Maintenance notes

Any future change to membership lookup predicates should preserve a useful index prefix. The index costs additional storage and write maintenance; keep it narrow. Review both fresh creation and existing version-1 upgrade paths. A rollback to old code should not need index deletion; the additive index does not change data semantics.
