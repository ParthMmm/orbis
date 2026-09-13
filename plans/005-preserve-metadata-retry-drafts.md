# Plan 005: Preserve current title and Tag edits when metadata retry completes

> **Executor instructions:** Read this file fully and run every step's verification gate. Stop rather than improvise when a STOP condition applies. Update only this plan's row in `plans/README.md` when execution ends.
>
> **Drift check (run first):** `git diff --stat 8cc79af..HEAD -- apps/apple/Orbis/AppModel.swift apps/apple/Orbis/RootView.swift apps/apple/OrbisTests/RevealTests.swift plans/README.md` and `git diff --stat -- apps/apple/Orbis/AppModel.swift apps/apple/Orbis/RootView.swift apps/apple/OrbisTests/RevealTests.swift plans/README.md`. Compare live code with the excerpts below; the second command catches uncommitted changes. Expected predecessor edits are allowed only as described here. Unexplained semantic drift means STOP.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — local draft merge and retry guard, no HTTP contract change
- **Depends on:** `plans/003-native-test-settings-isolation.md`; serialize after 004 for the shared native lane
- **Category:** bug
- **Audit finding:** 5; high confidence
- **Planned at:** commit `8cc79af`, 2026-09-11 (Mac local date), working-tree audit

## Scope

**In scope — only these files may change:**

- `apps/apple/Orbis/AppModel.swift`
- `apps/apple/Orbis/RootView.swift`
- `apps/apple/OrbisTests/RevealTests.swift`

`plans/README.md` may also change, only to update this plan's status. Preserve all pre-existing changes. Compare new changes against the executor's recorded start state, not a presumption that all dirty files belong to this task.

## Git workflow

Use an owner-approved isolated checkout and one writer per checkout. Suggested branch: `advisor/005-preserve-metadata-retry-drafts`. Do not stash, reset, or overwrite concurrent work. Do not install dependencies, commit, push, or open a PR without separate permission. Match the existing conventional style if a commit is later authorized, for example `fix(app): ask before forgetting the device`.

## Why this matters

A metadata retry suspends while the user can still edit the title and Tags in the reveal. On completion, the model reconstructs the reveal from the pre-request snapshot, silently discarding edits made during the request. Merge into the current draft instead, while preserving existing server metadata and dismissal behavior.

## Current state

`apps/apple/Orbis/AppModel.swift:398–414`:

```swift
func retryMetadata() async {
  guard let client, let open = reveal else { return }
  isSavingReveal = true
  revealFailure = nil
  defer { isSavingReveal = false }
  do {
    let updated = try await client.retryMetadata(open.set.id)
    guard reveal?.set.id == open.set.id, !Task.isCancelled else { return }
    replace(updated)
    reveal = Reveal(
      set: updated, title: open.titleUntouched ? updated.title : open.title,
      tags: open.tags)
```

`Reveal.titleUntouched` is true for an empty/whitespace title or a title equal to `set.title`. This is deliberate: an empty title means to keep the server-provided title, not save an empty string. `RootView.swift:284–330` binds its text field and `TagInput` directly to `model.reveal`; those fields remain editable. Done is disabled during saving, but Try again lacks that guard.

`RevealTests.swift` provides a SavedSet fixture and tests blank-title, edited-title, Tag, and dismissal semantics. `OrbisClientTests.swift:354–400` provides `StubProtocol.session(responder:holding:)`; `SupersessionTests.swift:37–45` waits for a request before editing state and awaiting an older Task. These last two files are read-only exemplars for this plan.

**Required predecessor, inlined:** after plan 003, construct tests with `AppModel(settings: MemoryClientSettings())` or `AppModel(client: client, settings: MemoryClientSettings())`. Test-host settings are memory-only. Do not run tests if that storage isolation is missing. The settings injection changes are expected drift; the draft merge above should otherwise still match.

ADR 0005 intentionally enriches synchronously when title is omitted; an explicitly supplied title belongs to the user, and provider failure still retains the Set. Do not change server metadata/title ownership. `CONTEXT.md`: a Tag is “A short label used to classify and filter Sets across the Library.” Preserve the current Tag draft even though metadata itself does not populate Tags.

## Commands you will need

| Purpose | Command | Expected result |
| --- | --- | --- |
| Native unit tests | `node scripts/native-lanes.mjs --unit` | All pass after storage isolation |
| Swift formatting check | `bun run native:format` | Exit 0 |
| Whitespace | `git diff --check` | Exit 0 |

Commands run from root, using the existing Xcode tools and `Orbis Lanes` simulator. Native verification was not run during the audit. Missing tools/signing/simulator are blockers. Read `.agents/skills/write-swift/SKILL.md`; keep XCTest and `@MainActor` patterns rather than introducing a new concurrency/test framework.

## Out of scope

No server metadata-state redesign, new API fields, provider work, broad write serialization, service-switch/session lifecycle fix, redesign of the reveal, or disabling title/Tag editing during a retry. Late responses after reconnecting or closing and reopening the same Set need a separate session-generation design; do not claim this narrow merge fixes those unselected findings.

## Steps

### Step 1: Build held-response regression coverage

Confirm plan 003's isolation and run the unit baseline. Add tests in `RevealTests.swift` that start a retry Task and wait until `StubProtocol` observes the metadata request. Its `holding` callback supplies a duration and delivery happens automatically; it is not a manually released gate. Use that timed fixture and the existing request-start wait pattern. On the main actor, require `isSavingReveal == true` immediately before mutating the active draft, with no intervening await. If the hold window was missed, fail the setup and await the started Task before returning; do not let edits made after completion count as a passing preservation test. The same main-actor turn must check pending state and apply the edits. Do not block the main actor, add arbitrary long sleeps, or rewrite the global responder.

Cover title-only, Tags-only, and both-field edits during the suspended retry. Capture the known current failure before implementing the fix: the old snapshot replaces these edits. Keep the failing test cases uncommitted and proceed directly to Step 2; do not mark the plan complete on this red gate.

**Verify:** `node scripts/native-lanes.mjs --unit` → new draft-preservation cases fail on the old implementation for the expected old-value mismatch; existing unrelated tests pass. Any other failure means STOP and diagnose rather than change unrelated code.

### Step 2: Merge with the latest draft and prevent overlapping retries

At entry to `retryMetadata`, return when `isSavingReveal` is already true. After the await, retrieve the current reveal into a fresh local and require its Set ID to equal the request's Set ID, with the existing cancellation check. Compute the new title from this current reveal's `titleUntouched` and `title`, not `open`. Copy Tags from the current reveal. Update the reveal's saved Set baseline to the returned Set, and keep `replace(updated)` so persisted Library metadata refreshes independently of the unsaved draft.

In `RootView.swift`, disable the Try again button while `isSavingReveal`, matching the existing Done guard. Keep text and Tag fields enabled; merely blocking edits would conceal rather than solve the data loss. Keep the existing `defer` for busy cleanup now that duplicate retry entry is guarded.

**Verify:** `node scripts/native-lanes.mjs --unit` → Step 1 regression cases pass; existing reveal behavior also passes. `bun run native:format` → exit 0.

### Step 3: Cover unchanged, dismissed, and failure paths

Add cases for: untouched title adopts the provider title; a pre-existing edited title remains; a blank/whitespace current title follows the existing untouched semantics; dismissal while pending stays dismissed; switching to a different Set does not alter the new draft; a second retry while pending does not issue a second request. Also assert the underlying saved Set refreshes while the unsaved draft stays distinct.

Distinguish two failure paths with separate pending-response tests. A metadata-provider failure is returned by the server as HTTP 200 with a Set whose `metadataState` is `failed`; it runs the success merge, must preserve current edits, refresh the saved Set baseline, and clear busy state. An HTTP error or transport failure enters the native catch path; it must preserve current edits, leave the saved baseline unchanged, expose the existing failure state, and clear busy state. Do not substitute a stubbed HTTP 500 for the provider-failure case.

Tests must await their started Tasks even if setup throws or the pending-state check fails, so no delayed stub response leaks into the next test. Use a do/catch cleanup path that awaits before rethrowing; an unawaited cleanup Task is not sufficient. Use an isolated settings store and fixture network responses only.

**Verify:** `node scripts/native-lanes.mjs --unit && bun run native:format && git diff --check` → exit 0; all named scenarios pass.

## Test plan

Use `RevealTests` fixtures and `StubProtocol`'s existing responder/holding API. Synchronize on actual request start, assert pending state on the main actor immediately before synchronous draft edits, then await completion before checking both the current draft and saved Library state. A missed timed-hold window is a setup failure, never evidence of draft preservation. Keep the existing serial-test assumption because the shared protocol fixture uses static state; do not enable parallel test execution.

## Done criteria

- [ ] Mid-request title/Tag edits survive retry completion.
- [ ] Untouched/blank title semantics and saved metadata refresh remain correct.
- [ ] Dismissed/different-Set reveals are not replaced by the late result.
- [ ] Duplicate retry entry sends no second request; HTTP-200 provider failure and HTTP/transport failure each preserve edits and clear busy state, with correct distinct baseline behavior.
- [ ] Native unit, formatting, and whitespace commands exit 0.
- [ ] No changes outside Scope; index status updated.

## STOP conditions

Stop without safe test settings, on unexplained AppModel drift, if the test requires modifying the shared StubProtocol beyond its existing API, or if the fix requires broad mutation/session serialization. Stop on two failed verification attempts, excluding the single expected regression-red run in Step 1. Do not remove failure coverage or disable editing to satisfy the tests.

## Maintenance notes

Any future merge after an await must distinguish the persisted Set snapshot from the current user draft. Review both title and Tags, not just the visible title. Broader stale responses during reconnects, same-Set reopening, or detail mutations remain separate unselected work.
