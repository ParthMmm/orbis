# Plan 004: Keep the existing pairing when a Keychain write fails

> **Executor instructions:** Read this file fully and run every step's verification gate. Stop rather than improvise when a STOP condition applies. Update only this plan's row in `plans/README.md` when execution ends.
>
> **Drift check (run first):** `git diff --stat 8cc79af..HEAD -- apps/apple/Orbis/ClientSettings.swift apps/apple/OrbisTests/ClientSettingsTests.swift apps/apple/OrbisTests/ConnectionEditorTests.swift plans/README.md` and `git diff --stat -- apps/apple/Orbis/ClientSettings.swift apps/apple/OrbisTests/ClientSettingsTests.swift apps/apple/OrbisTests/ConnectionEditorTests.swift plans/README.md`. Compare live code with the excerpts below; the second command catches uncommitted changes. Expected predecessor edits are allowed only as described here. Unexplained semantic drift means STOP.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — narrow write-error change, with injected failure coverage
- **Depends on:** `plans/003-native-test-settings-isolation.md`
- **Category:** security
- **Audit finding:** 4; high confidence in destructive control flow, real error conditions not induced
- **Planned at:** commit `8cc79af`, 2026-09-11 (Mac local date), working-tree audit

## Scope

**In scope — only these files may change:**

- `apps/apple/Orbis/ClientSettings.swift`
- `apps/apple/OrbisTests/ClientSettingsTests.swift`
- `apps/apple/OrbisTests/ConnectionEditorTests.swift`

`plans/README.md` may also change, only to update this plan's status. Preserve all pre-existing changes. Compare new changes against the executor's recorded start state, not a presumption that all dirty files belong to this task.

## Git workflow

Use an owner-approved isolated checkout and one writer per checkout. Suggested branch: `advisor/004-preserve-keychain-on-write-failure`. Do not stash, reset, or overwrite concurrent work. Do not install dependencies, commit, push, or open a PR without separate permission. Match the existing conventional style if a commit is later authorized, for example `fix(app): ask before forgetting the device`.

## Why this matters

The code claims a failed token update preserves a pairing, but its generic error branch deletes the current Keychain item before trying to add the replacement. If the add also fails, the old pairing is lost. A failed write should report failure and leave the stored credential intact, not try destructive recovery.

## Current state

At the audit baseline, `ClientSettings.swift:81–93` contains:

```swift
switch SecItemUpdate(base as CFDictionary, attributes as CFDictionary) {
case errSecSuccess:
  return true
case errSecItemNotFound:
  return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
default:
  SecItemDelete(base as CFDictionary)
  return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
}
```

The update attributes are initially copied from `base`, including class/service/account query keys. `AppModel.connect` checks the Bool from `settings.store(deviceToken:)` before committing a new address. That guard must remain effective.

**Required predecessor state, inlined:** plan 003 introduces a main-actor `ClientSettingsStore` interface with `serviceAddress`, `deviceToken`, `store(deviceToken:)`, and `configuredClient`; models accept a memory store in tests. `KeychainStore` becomes an instance initialized with an explicit service/account, and `ClientSettingsTests.swift` contains successful round-trip tests in unique `app.orbis.tests.<UUID>` namespaces. The test host uses memory settings and never reads the development credential provider. These interface/storage changes are expected drift; the destructive write branch should still be present. If plan 003 is not complete and verified, STOP before running native tests.

ADR 0004 says tokens are per-device and the host stores only their digest. Keep the Apple credential in device-only Keychain storage; do not add a plaintext backup. `CONTEXT.md` calls the saved collection the Library. Credential failure must not erase the currently working Library session.

## Commands you will need

| Purpose | Command | Expected result |
| --- | --- | --- |
| Swift lint | `bun run native:format` | Exit 0 |
| Native unit baseline/final | `node scripts/native-lanes.mjs --unit` | All unit tests pass, including isolated Keychain tests |
| Whitespace | `git diff --check` | Exit 0 |

Run from the repository root using already-installed tools. The native lane uses a disposable service and the existing `Orbis Lanes` simulator. Do not install or bypass signing to get it running. Read `.agents/skills/write-swift/SKILL.md` and the available Axiom Keychain guide before changing Security calls.

## Out of scope

No real Keychain mutations during manual diagnosis, credential rotation, accessibility-policy change, synchronized/iCloud storage, retry loop, UI redesign, development-config changes, explicit-forget semantics change, or generic persistence framework. Do not alter AppModel connection behavior unless the scoped tests expose a separate defect; that case is a STOP for scope review.

## Steps

### Step 1: Confirm safe predecessor and inject Security outcomes

Verify plan 003's isolation gates and passing native baseline. In `ClientSettings.swift`, add a minimal main-actor injectable Security-operation adapter around `KeychainStore`'s existing update/add/delete/read calls. The live adapter calls the same Security APIs. The fake adapter in `ClientSettingsTests.swift` records query keys and call order, holds fixture data, and returns chosen `OSStatus` values. It must not touch the system Keychain. Keep the seam local to this file; no dependency package or unsafe Sendable annotation.

Leave the live write logic unchanged in this step and prove the successful existing update/add paths use the adapter. Query and update dictionaries must remain separately observable by the fake.

**Verify:** `node scripts/native-lanes.mjs --unit` → all pre-existing tests and adapter happy-path tests pass. `bun run native:format` → exit 0.

### Step 2: Make non-not-found errors non-destructive

Build the update query from class/service/account identity. Build update attributes from mutable value data and the existing `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` policy, not by copying the identity query. Build the add dictionary by merging query identity with those attributes.

Implement exactly this result policy:

- Update success: return true; do not add or delete.
- `errSecItemNotFound`: attempt one add; return whether it succeeded.
- Every other update status: return false; do not add or delete.
- Add failure, including `errSecDuplicateItem` caused by another writer: return false; do not delete the competing/existing item and do not loop.
- Explicit removal through `store(deviceToken: nil)` remains a distinct operation; never invoke it as write recovery.

Correct the old comment about whole-item replacement. Do not add a backup credential, dump Security query contents, or weaken accessibility to turn an error into success.

Add tests for update success, absent-item add success, absent-item add failure, interaction-not-allowed update failure, authentication/parameter update failure, and duplicate-item add failure. For non-not-found update failures, assert the fake retains the old fixture data, receives one update call, and receives zero add/delete calls. Assert immutable query keys are absent from the update attributes. Parameterize representative error statuses instead of hardcoding a catch-all success behavior.

**Verify:** `node scripts/native-lanes.mjs --unit` → all pass, including the six named status scenarios and dictionary/call-order assertions.

### Step 3: Verify the connection-level failure contract

In `ConnectionEditorTests.swift`, use a settings-store fake whose `store` returns false and whose existing token/address stay unchanged. Complete a successful stubbed health request, then assert the failed persistence attempt does not adopt the new address, does not forget the old pairing, and exposes the existing failure state. Assert no secret value appears in user-facing error text. Keep networking local to `StubProtocol`.

**Verify:** `node scripts/native-lanes.mjs --unit && bun run native:format && git diff --check` → exit 0. `git status --short` → only scoped executor changes and ignored artifacts.

## Test plan

Follow the isolated round-trip test from plan 003 for real successful persistence; use only the fake Security adapter for failure paths. Never try to lock, corrupt, or delete the developer's actual Keychain item to reproduce a failure. Follow `ConnectionEditorTests` for the model-level Bool failure gate.

## Done criteria

- [ ] Non-not-found update failures return false with no add/delete calls and old fixture data intact.
- [ ] Only item-not-found attempts an add; duplicate/add failure never deletes or loops.
- [ ] Update attributes exclude identity query keys and preserve device-only accessibility.
- [ ] The failed connection save test leaves the existing configuration intact.
- [ ] Native unit, formatting, and whitespace commands exit 0.
- [ ] Scope respected and index status updated.

## STOP conditions

Stop if plan 003's isolated storage contract is unavailable, if tests use the production namespace, if the adapter requires cross-thread mutable state or new unsafe concurrency annotations, or if the connection failure requires an out-of-scope AppModel change. Stop for unexplained drift or two failed verification attempts. Do not restore the delete-then-add fallback to make a failing test pass.

## Maintenance notes

A future explicit migration of Keychain attributes needs its own non-destructive migration plan, not fallback deletion on any error. Review call ordering and the distinction between update query and mutable attributes. Failure of explicit deletion is a separate issue; this plan does not change the public Bool contract of forgetting a device.
