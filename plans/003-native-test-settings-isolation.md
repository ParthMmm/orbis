# Plan 003: Keep native tests out of real pairing storage

> **Executor instructions:** Read this file fully and run every step's verification gate. Stop rather than improvise when a STOP condition applies. Update only this plan's row in `plans/README.md` when execution ends.
>
> **Drift check (run first):** `git diff --stat 8cc79af..HEAD -- apps/apple/Orbis/ClientSettings.swift apps/apple/Orbis/AppModel.swift apps/apple/OrbisTests/ClientSettingsTests.swift apps/apple/OrbisTests/OrbisClientTests.swift apps/apple/OrbisTests/ConnectionEditorTests.swift apps/apple/OrbisTests/LibraryFilterTests.swift apps/apple/OrbisTests/PasteAndFileTests.swift apps/apple/OrbisTests/RevealTests.swift apps/apple/OrbisTests/SetPageTests.swift apps/apple/OrbisTests/SupersessionTests.swift apps/apple/OrbisUITests/LibraryUITests.swift apps/apple/project.yml plans/README.md` and `git diff --stat -- apps/apple/Orbis/ClientSettings.swift apps/apple/Orbis/AppModel.swift apps/apple/OrbisTests/ClientSettingsTests.swift apps/apple/OrbisTests/OrbisClientTests.swift apps/apple/OrbisTests/ConnectionEditorTests.swift apps/apple/OrbisTests/LibraryFilterTests.swift apps/apple/OrbisTests/PasteAndFileTests.swift apps/apple/OrbisTests/RevealTests.swift apps/apple/OrbisTests/SetPageTests.swift apps/apple/OrbisTests/SupersessionTests.swift apps/apple/OrbisUITests/LibraryUITests.swift apps/apple/project.yml plans/README.md`. Compare live code with the excerpts below; the second command catches uncommitted changes. Expected predecessor edits are allowed only as described here. Unexplained semantic drift means STOP.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED — settings injection touches connection setup; production persistence must remain unchanged
- **Depends on:** none
- **Category:** tests
- **Audit finding:** 3; high confidence in shared storage, no destructive hosted tests were run
- **Planned at:** commit `8cc79af`, 2026-09-11 (Mac local date), working-tree audit

## Scope

**In scope — only these files may change:**

- `apps/apple/Orbis/ClientSettings.swift`
- `apps/apple/Orbis/AppModel.swift`
- `apps/apple/OrbisTests/ClientSettingsTests.swift`
- `apps/apple/OrbisTests/OrbisClientTests.swift`
- `apps/apple/OrbisTests/ConnectionEditorTests.swift`
- `apps/apple/OrbisTests/LibraryFilterTests.swift`
- `apps/apple/OrbisTests/PasteAndFileTests.swift`
- `apps/apple/OrbisTests/RevealTests.swift`
- `apps/apple/OrbisTests/SetPageTests.swift`
- `apps/apple/OrbisTests/SupersessionTests.swift`
- `apps/apple/OrbisUITests/LibraryUITests.swift`
- `apps/apple/project.yml`

`plans/README.md` may also change, only to update this plan's status. Preserve all pre-existing changes. Compare new changes against the executor's recorded start state, not a presumption that all dirty files belong to this task.

## Git workflow

Use an owner-approved isolated checkout and one writer per checkout. Suggested branch: `advisor/003-native-test-settings-isolation`. Do not stash, reset, or overwrite concurrent work. Do not install dependencies, commit, push, or open a PR without separate permission. Match the existing conventional style if a commit is later authorized, for example `fix(app): ask before forgetting the device`.

## Why this matters

Native tests call the same static settings API as the application. One test overwrites the production Keychain item and deletes it in `defer`; connection tests call `connect()` and `forget()`, which also mutate persistent settings. Even `AppModel(client:)` reads the stored token, and a macOS Debug build can read development credentials from the user's home directory. Tests need isolated settings before credential regressions or expanded native CI can be run safely.

## Current state

- `apps/apple/Orbis/ClientSettings.swift:32–38`:
  ```swift
  static var serviceAddress: String? {
    get { UserDefaults.standard.string(forKey: addressKey) ?? developmentConfiguration?.address }
    set { UserDefaults.standard.set(newValue, forKey: addressKey) }
  }
  static var deviceToken: String? {
    Keychain.read() ?? developmentConfiguration?.token
  }
  ```
- `ClientSettings.swift:15–29` reads a device credential from a home-directory development configuration in macOS Debug builds. Do not open or copy that file. Tests must bypass this provider entirely, not merely clear defaults.
- `ClientSettings.swift:65–74` fixes the Keychain service/account to the application's production identity. `OrbisClientTests.swift:33–43` uses static `ClientSettings.store` for first save, replacement, and deletion.
- `AppModel.swift:132–159` has `init()` and `init(client:)`; both consult static settings. The default initializer handles `-orbisResetSettings` by clearing persistent state. `connect`, `forget`, and the connection editor use the same statics.
- `ConnectionEditorTests.swift` constructs models without a storage dependency; its async connection tests defer `model.forget()`.
- `project.yml` is the source of the ignored generated Xcode project. It targets iOS/macOS 26 with Swift 6 complete concurrency checking and has a hosted `OrbisTests` bundle. The app host itself constructs `RootView`/`AppModel`, so injecting only models in test methods is not sufficient.
- `OrbisUITests/LibraryUITests.swift:7–22` passes `-orbisResetSettings` to `XCUIApplication` but no isolated settings mode.
- `CONTEXT.md` calls saved recordings Sets and their collection the Library. Isolation must not change visible pairing, Library behavior, or persisted production keys.

Use `@MainActor` XCTest classes as in `ConnectionEditorTests.swift`. Keep the existing XCTest runner; do not migrate to Swift Testing. Read `.agents/skills/write-swift/SKILL.md` before Swift changes. For Keychain details, use the installed Axiom security/keychain reference if available; do not guess Security API behavior.

## Commands you will need

From the repository root:

| Purpose | Command | Expected result |
| --- | --- | --- |
| Tool availability | `command -v xcodegen; xcrun --find swift-format; xcodebuild -version` | Existing Xcode and XcodeGen available |
| Swift style, safe before isolation | `bun run native:format` | Exit 0 |
| Unit lane, ONLY after isolation | `node scripts/native-lanes.mjs --unit` | Design and native unit tests all pass |
| Generate project | `(cd apps/apple && xcodegen generate)` | Exit 0; generated project remains ignored |
| Mac hosted unit tests, ONLY after isolation | `xcodebuild -project apps/apple/Orbis.xcodeproj -scheme Orbis -destination 'platform=macOS' CODE_SIGN_IDENTITY=- -derivedDataPath apps/apple/DerivedData -only-testing:OrbisTests -parallel-testing-enabled NO test` | Exit 0, `TEST SUCCEEDED` |
| Whitespace | `git diff --check` | Exit 0 |

The checked-in unit lane starts an ephemeral local service and uses the simulator named `Orbis Lanes`. It needs existing local tooling/simulator; do not create, download, or install anything without permission. The Mac command derives from the checked-in lane's Xcode invocation and project settings; it was not run during the audit. Native app tests do not yet have an audit-certified passing baseline. Signing or host failures must be reported, not bypassed with `CODE_SIGNING_ALLOWED=NO`.

## Out of scope

No real Keychain cleanup, development-credential reads, production settings reset, token rotation, bundle identifier/signing changes, global test-runner replacement, CI expansion, UI redesign, or server work. Do not fix the destructive Keychain write fallback here; plan 004 needs an independently testable baseline first. Do not change `scripts/native-lanes.mjs` or install a simulator to get a green result.

## Steps

### Step 1: Define an instance settings boundary without running native tests

In `ClientSettings.swift`, replace direct static application access with these internal roles, retaining production key names and persistence behavior:

- `@MainActor protocol ClientSettingsStore: AnyObject`: mutable `serviceAddress: String?`, readable `deviceToken: String?`, and `@discardableResult func store(deviceToken: String?) -> Bool`.
- A protocol extension provides `isConfigured` and `configuredClient(session: URLSession = .shared)` using the current URL/HTTPS validation unchanged.
- `LiveClientSettings` implements the interface with the existing defaults, development fallback, and Security operations. Its constructor takes explicit dependencies: a `UserDefaults` instance, a namespaced `KeychainStore` instance, and a lazy development-configuration provider. Isolated persistence tests supply a unique defaults suite, a unique Keychain namespace, and a provider returning nil. Production construction supplies the existing defaults, production Keychain identity, and home-file provider. Do not eagerly evaluate that provider during factory construction.
- `MemoryClientSettings` implements the same interface using in-memory address/token fields. Instances must not share state. It never reads defaults, Keychain, or the home directory.
- Keep `ClientSettings` only as a factory namespace with `forCurrentProcess() -> any ClientSettingsStore`. Its Debug path delegates to a main-actor helper `makeForProcess(environment:isTestHost:liveStore:)`, taking an environment snapshot, a Bool, and a lazy `() -> any ClientSettingsStore` constructor. Select a new memory store if the environment says `ORBIS_TEST_SETTINGS=memory` **or** `isTestHost` is true; do not invoke the live constructor on either path. The process entry recognizes XCTest host indicators before resolving storage: the Foundation runtime lookup `NSClassFromString("XCTestCase")` and the presence of `XCTestConfigurationFilePath` or `XCTestSessionIdentifier` in the environment. These are defense in depth, not a substitute for the generated-scheme gate below. A recognized hosted test missing the override must still select memory, never default to live storage. Unit-test the helper with supplied snapshots/flags and a live-constructor call counter rather than modifying the process environment. Release production construction ignores the Debug helper/override and uses the existing live behavior.
- Change the private fixed Keychain enum to an internal instance `KeychainStore`, initialized with an explicit service and account. Only production construction supplies the existing production identity; test callers must supply a unique `app.orbis.tests.<UUID>` service. Do not change the write algorithm in this plan.

This is a small storage seam, not a dependency framework. Keep its operations main-actor isolated so Swift 6 needs no new unsafe Sendable annotations.

**Verify:** `bun run native:format` → exit 0. Native tests remain prohibited until Step 2 has removed all live test paths. Temporary compile breakage while changing the interface must be resolved in Step 2 before any test run.

### Step 2: Route every model and test-host path through the boundary

Store `private let settings: any ClientSettingsStore` in `AppModel`. The normal initializer accepts an injectable settings store, defaulting to the process factory. Require an explicit settings argument on the test-oriented `init(client:settings:)`. Replace every static settings read/write in model initialization, connection editing, `connect`, and `forget` with this instance. The reset launch argument must clear only the selected store.

Update every model construction in the eight listed existing unit-test files to supply a fresh `MemoryClientSettings`, seeding only fixture values needed by that test. Existing `OrbisClient`/`StubProtocol` injection remains unchanged. Do not let a fixture reuse a global memory store.

Add `ORBIS_TEST_SETTINGS: memory` to the scheme test environment in `project.yml`, so the hosted app's own default model cannot read real settings. Also set `app.launchEnvironment["ORBIS_TEST_SETTINGS"] = "memory"` in the UI journey launch helper before launching. The reset flag then clears memory, not a device pairing. Do not run UI journeys as part of this plan.

Move the real-Keychain round-trip test out of `OrbisClientTests.swift` into `ClientSettingsTests.swift`. It must construct a unique Keychain namespace and delete only that exact namespace in cleanup. For any defaults test, use `UserDefaults(suiteName: uniqueName)` and remove only that suite. Never snapshot/restore the real token as a substitute for isolation.

**Verify:** `rg -n 'ClientSettings\.(store|serviceAddress|deviceToken|configuredClient)' apps/apple/Orbis/AppModel.swift apps/apple/OrbisTests` → no matches (rg exit 1 is expected). `rg -n 'ORBIS_TEST_SETTINGS' apps/apple/project.yml apps/apple/OrbisUITests/LibraryUITests.swift` → both contain the explicit memory-mode wiring. Inspect every remaining `AppModel(` call in unit tests and confirm an explicit memory store.

Before **any** native test execution, generate the ignored project and verify the actual scheme, not just its YAML source:

```sh
(cd apps/apple && xcodegen generate)
python3 - <<'PYSCHEME'
import xml.etree.ElementTree as ET
p = "apps/apple/Orbis.xcodeproj/xcshareddata/xcschemes/Orbis.xcscheme"
action = ET.parse(p).getroot().find("TestAction")
assert action is not None
assert action.get("buildConfiguration") == "Debug"
assert action.get("shouldUseLaunchSchemeArgsEnv") == "NO"
entries = action.findall("./EnvironmentVariables/EnvironmentVariable")
selected = [e for e in entries if e.get("key") == "ORBIS_TEST_SETTINGS"]
assert len(selected) == 1
assert selected[0].get("value") == "memory"
assert selected[0].get("isEnabled") == "YES"
print("Debug TestAction uses enabled memory settings")
PYSCHEME
```

Expected: exit 0 and the stated non-secret confirmation; do not print the whole scheme, which can contain lane credentials. `bun run native:format` must also exit 0. If any generated-environment assertion fails, stop before tests and repair only the scoped scheme/factory wiring. The native lane regenerates from this same YAML; inspect its existing generation call to ensure no alternate spec or environment override removes the memory setting. The fail-closed Debug factory protects the host before test methods run if propagation is nevertheless absent.

### Step 3: Prove storage independence and keep production semantics

Add `ClientSettingsTests.swift` with at least these cases:

1. Two memory stores do not share address or token values.
2. Forgetting and connecting through one injected model changes only that store; an independent sentinel store remains untouched.
3. The test factory selects memory without invoking the injected lazy live constructor: test explicit memory mode, recognized host with no override, and recognized host with an invalid override. Assert a zero constructor count in every case; separately test that an ordinary non-test Debug process calls the supplied live constructor once. Do not inspect the real home file or mutate process environment.
4. A live-store instance constructed with a unique defaults suite, unique Keychain namespace, and disabled development fallback persists/replaces/removes a synthetic fixture token and address.
5. Clearing that isolated store does not alter another isolated namespace.
6. `configuredClient` retains existing address validation and never creates a configured client from missing credentials.
7. The reset launch behavior is tested through injected settings or a factored settings-only helper; it must not require launching a production-configured app.

Use generated synthetic values for fixture credentials and never put real values into test assertions or logs. Round-trip Keychain tests exercise only successful operations; injected Security failure cases belong to plan 004.

**Verify:** `node scripts/native-lanes.mjs --unit` → all design and app unit tests pass. Do not skip the Keychain test when it fails due to entitlements; report the runner blocker and leave the plan incomplete.

### Step 4: Verify the macOS host and close the handoff

Generate the project and run the Mac hosted unit command from the command table with parallel testing disabled. The scheme environment must keep the host in memory mode. Then run native formatting and whitespace checks. Record which platform commands ran and any infrastructure blockers in the index; do not mark DONE based only on the 29 design-package tests.

**Verify:** the Mac hosted unit command → `TEST SUCCEEDED`; `bun run native:format && git diff --check` → exit 0. `git status --short` → no executor-created changes outside Scope; generated project/DerivedData stay ignored.

## Test plan

Use `ConnectionEditorTests` for actor-isolated assertions and existing `StubProtocol` fixtures for networking. Persistence tests must name their isolated namespace explicitly and clean only that namespace. Run the native unit lane and the Mac hosted unit command only after the source scan and host environment gates. Do not inspect production settings to demonstrate non-interference; verify disjoint injected stores and production-query exclusion by construction.

## Done criteria

- [ ] No unit test or hosted test startup calls production settings storage or its development fallback; generated Debug TestAction assertions pass before the first test run.
- [ ] A recognized Debug test host falls back to memory even with a missing/invalid environment override, without invoking the live-store constructor.
- [ ] All model test constructors inject a fresh settings store.
- [ ] The direct Keychain test uses an isolated namespace, not the app identity.
- [ ] The seven storage/isolation cases exist and pass; native unit lane and Mac hosted unit command exit 0.
- [ ] Native formatting and whitespace gates exit 0; only scoped source/index files changed.
- [ ] Index status updated. If native verification is blocked, use BLOCKED, not DONE.

## STOP conditions

Stop for semantic drift, unknown settings callers outside Scope, missing Xcode/simulator/signing support, two failed verification attempts, or a need to widen the storage abstraction beyond this seam. Stop immediately if any test still resolves the production Keychain namespace or the home-directory provider. Never clear a real credential to make a test pass. If the test environment does not reach the host process, fix the scoped scheme/factory wiring before executing tests; do not weaken the isolation requirement.

## Maintenance notes

New native tests must inject independent stores. UI relaunch-persistence tests, if added later, need a dedicated persisted test namespace rather than the current memory mode. A reviewer should scrutinize factory evaluation order, hidden static reads, and cleanup query scope. Plan 004 depends on `ClientSettingsStore`, `MemoryClientSettings`, and the explicitly namespaced `KeychainStore` established here; keep those interfaces stable for that handoff.
