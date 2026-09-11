# Orbis native clients and Vanta playback plan

This program turns Orbis from a loopback-only Electron library into a native Apple experience backed by the existing Bun, Effect v4, and SQLite service on Vanta. It covers the private Cobalt trial, one multiplatform SwiftUI app, metadata enrichment, retained audio, streaming playback with system controls, one synchronized Listening Queue, and listening statistics.

Thirteen units land in dependency order. U1 is the Cobalt trial. U2 is the native foundation and Library browsing. U3 through U13 build the remaining ticket behaviours. Units are numbered by the order they may start, not by ticket number.

The rule the program enforces is that no unit is done until its unit, live, and perf boxes carry evidence at one recorded SHA.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the operator's skill store copy of `~/.pi/agent/npm/node_modules/@zenspc/pi-pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. This repository has no pull request surface, so every unit lands as a reviewed commit series on `main` and the operator merges by fast-forward. See **Deliver each unit** in the Program checklist for the landing rule this repository uses instead of forge pull requests.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Three prototype results already constrain this plan and are recorded in Appendix A. A generated Xcode project builds, tests, and screenshots both platforms from the command line. AVFoundation plays AAC, MP3, Ogg Opus, and PCM but rejects WebM Opus, and it issues byte range requests for every read.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on her explicit go.
- [ ] Record the baseline SHA of `main` in this file before touching the host. The Cobalt trial ticket requires a recorded fixed point for review.
- [ ] Restore a green baseline before any unit starts. At `origin/main` the only failing task is `format:check`, which reports exactly two files, `AGENTS.md` and `docs/research/cobalt-self-hosting.md`. Fix those files so `bun run check` exits zero, and record the SHA where it does.
- [ ] Confirm the host state on Vanta with the read-only check in `docs/ops/cobalt-trial.md`. Recheck Docker availability, free memory and disk, port 9000, and the running container list. Prior checks are not proof that the host is unchanged.
- [ ] Create one dedicated iPhone simulator for live lanes, named `Orbis Lanes`. Do not use a simulator that has a signed-in Apple ID, because a system account dialog appears over the app and pollutes screenshots.
- [ ] Gate the macOS live lanes behind a one-time Screen Recording grant to the lane runner. Until the grant exists, macOS lanes record Accessibility tree text instead of windows, per the boot recipe.
- [ ] On her go, record a standing goal with this exact text. "Execute `docs/plans/native-clients-program.md` on `main` in unit order U1 through U13. No unit is done until its unit, live, and perf boxes carry evidence at one recorded SHA. The operator merges. The program is done when U13 is verified and every ticket from 2 to 15 is closed with its evidence linked."
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:AGENTS.md`
  - [ ] `git show origin/main:docs/agents/domain.md`
  - [ ] `git show origin/main:docs/agents/issue-tracker.md`
  - [ ] `git show origin/main:docs/agents/triage-labels.md`
  - [ ] `git show origin/main:README.md`
  - [ ] `git show origin/main:CONTEXT.md`
- [ ] Arm the 30-minute audit tick. In a local session, a real terminal with a recurring wake. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the standing goal and `docs/agents/domain.md` from trunk. Audit the operation against both and fix drift in this tick. Probe every active unit and judge progress by side effects only. Stand down a stuck unit and dispatch its replacement now. Then send the operator a status message, whether or not anything changed, with the unit table of id, owner, state, and head SHA, the verdicts since the last tick, what landed, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per started unit with the full lifecycle this plan defines.
- [ ] Hold one writer per working tree. This repository has had concurrent agent writers, so an owner works in its own `git worktree` and never in a shared checkout.
- [ ] Follow this dependency graph. Start dependent work only after its parent lands.
  - [ ] U1 first. It blocks U6 and U7.
  - [ ] U2 after U1. It blocks U3, U6, and every native unit.
  - [ ] U3 after U2. It blocks U12 and U13.
  - [ ] U4 and U5 after U2, in parallel with each other.
  - [ ] U6 after U1 and U2.
  - [ ] U7 after U3 and U6.
  - [ ] U8 after U7. U9 after U8. U10 after U5 and U9. U11 after U10.
  - [ ] U12 and U13 after U3, in parallel with the U7 through U11 chain.
- [ ] Hold the file boundaries. U1 touches `deploy/cobalt/**`, `scripts/smoke-cobalt*.mjs`, and `docs/ops/**`. U2 owns `apps/native/**`, the Xcode generation spec, and the server identity boundary. Playback units own `apps/native/**/Playback/**`. Server units own `apps/server/src/**` and `packages/contracts/src/index.ts`.
- [ ] Hold the review gate. U2, U3, U4, U5, U7, U8, U9, U10, U11, U12, and U13 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.
- [ ] Route U2's Tailscale trust design through the `architect` skill before writing server code, and the audio format record through `interrogate` before it is accepted. Appendix D names both.

### PR mechanics, for every unit in this repository

- [ ] This repository has no pull request surface. Create one branch per unit named `unit/<id>-<slug>` from current `main`, and land it as a reviewed commit series.
- [ ] Run `bun run check` once before the push. It must exit zero. Individual commands are available for iteration but are not the evidence.
- [ ] Run `/skill:deslop` before each commit and `/skill:no-comments` before review.
- [ ] Keep every commit message in Conventional Commits form, matching the existing history.
- [ ] Rebase onto current `main` before the merge-ready report, and again immediately before Fast-forward. Orbis has no forge, so the unit lands by fast-forward after the operator's review.
- [ ] Triage every Bugbot and security-reviewer comment per the operator's `references/bugbot-triage.md` when a review surface exists.

### Verdict and merge, for every unit

- [ ] At the merge-ready SHA, run the swarm per `~/.pi/agent/npm/node_modules/@zenspc/pi-pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the unit's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the plan.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] The unit lands only as a contiguous verified run from the root of unlanded work. If a unit is rejected, its dependents do not start.
- [ ] Close the unit's GitHub ticket with a resolution comment that links the SHA, the receipts, and the plan box that verified it.

### Boot recipe, for every live lane

Each live lane runs at the unit head. Drive through the control skill for the surface, never by hand.

- [ ] `git fetch origin && git checkout <unit head SHA>`.
- [ ] Native iOS simulator surface. Start from `bun run --filter @orbis/server dev` with `ORBIS_DATA_DIR` set to a temporary directory, then `bun run native:lanes` which generates the project, builds, runs `xcodebuild test`, and exports attachments. Read results with `xcrun xcresulttool`.
- [ ] Native macOS surface. Build with `xcodebuild -destination 'platform=macOS' -derivedDataPath <tmp> build`, launch the built app, then drive it with `osascript` System Events calls through `bun run native:macos-drive`. Record the Accessibility tree as text evidence. Do not rely on `xcodebuild test` for macOS, because the UI test runner is killed before bootstrap on this machine.
- [ ] Server surface. Drive `apps/server/src/test-http.ts` and repeated `curl` calls against a temporary server on an ephemeral port with a temporary SQLite database and media directory.
- [ ] Vanta surface. Drive `scripts/smoke-cobalt.mjs` from the repository root with the fixtures for the case. Use only read-only `ssh vanta` commands for diagnostics. Never run `docker system prune` or change Caddy or Tailscale Serve rules.
- [ ] Raycast surface. Drive the command module with controlled Browser Extension, clipboard, and HTTP responses through the unit's test harness.
- [ ] Deliver input only through the control skill's commands. Read-only diagnostics are `curl`, `docker inspect`, `ss`, `ffprobe`, `xcrun simctl`, and the Accessibility tree dump.
- [ ] Save every screenshot to `/tmp/orbis-swarm-<unit-id>/lane-<n>/<slug>.png` and return the paths with the report. The macOS surface saves `<slug>.txt` until the Screen Recording grant exists, and names that substitution in its report.

## Run the private Cobalt trial and record the decision (U1)

**Depends on.** None. Ticket 2. Blocks U6 and U7.

**Files.**

- [ ] Edit `docs/ops/cobalt-trial.md` to add an evidence and decision section.
- [ ] Create `docs/ops/cobalt-trial-evidence.md` holding the sanitized report and the go or no-go recommendation.
- [ ] Edit `docs/adr/0003-cobalt-download-viability.md` with the outcome if the trial is inconclusive.
- [ ] Leave `deploy/cobalt/compose.yaml` and `scripts/smoke-cobalt.mjs` unchanged unless a defect appears, in which case fix it in its own commit.

**Build.**

- [ ] Record the pre-trial baseline SHA and the read-only host check output in `docs/ops/cobalt-trial-evidence.md`.
- [ ] Deploy the pinned Cobalt image on Vanta with `docker compose up -d cobalt`, and confirm with `docker inspect` that the running image includes the pinned digest.
- [ ] Generate the API key with `scripts/create-cobalt-key.mjs --output keys.json`, keep it outside source control, and confirm the port is published on the Tailscale address only.
- [ ] Run `scripts/smoke-cobalt.mjs` with the five permitted Source Links from ticket 3 as fixtures, including the longest one as the multi-hour case.
- [ ] Write the sanitized report, the observed format, byte count, duration, and processing time per fixture, and a separate verdict for each source into `docs/ops/cobalt-trial-evidence.md`.
- [ ] State the go or no-go recommendation and every untested case explicitly.

**You see.**

- [ ] `scripts/smoke-cobalt.mjs` exits 0 for a pass or 1 for a failed required check, and the report names each case separately.
- [ ] The evidence file contains no API key, no tunnel URL, and no third-party URL that is not already in ticket 3.
- [ ] `ss -ltnp` on Vanta shows port 9000 bound to the Tailscale address and not to `0.0.0.0`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `bun run test:cobalt` passes offline at the unit head, so the smoke tool's own logic is checked without the host.
- [ ] Existing Orbis server tests still pass with `bun run --filter @orbis/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is the Vanta Cobalt deployment, and the control skill is `scripts/smoke-cobalt.mjs` plus read-only `ssh vanta` diagnostics.

- [ ] Lane 1. Regression lane against trunk. Run the read-only host check at trunk and at head. Trunk has no Cobalt container, so record that fact and gate the end state the operator waits for, a healthy container on the Tailscale address with port 9000 bound there and nowhere else. Save `host-state-before-after.png`. Pass when the only difference in the container list is the added trial container.
- [ ] Lane 2. A processing request without an API key is rejected. Save `auth-missing-key.png`. Pass when the request fails and the report records it as a rejection.
- [ ] Lane 3. A processing request with a known-invalid key is rejected. Save `auth-bad-key.png`. Pass when the request fails. Pass when the report records it separately from the missing-key case.
- [ ] Lane 4. An unsupported URL with a valid key returns an error. Save `unsupported-url.png`. Pass when Cobalt returns an error and the report does not count it as a coverage failure.
- [ ] Lane 5. A permitted YouTube Source Link downloads complete audio. Save `youtube-download.png`. Pass when the file decodes completely with `ffmpeg`, `ffprobe` reports the expected duration within tolerance, and the report records format, bytes, and processing time.
- [ ] Lane 6. A permitted SoundCloud track downloads complete audio. Save `soundcloud-download.png`. Pass when the same predicates hold and the report keeps the SoundCloud verdict separate from the YouTube verdict.
- [ ] Lane 7. A permitted Source Link longer than three hours and no longer than six hours downloads complete audio. Save `long-set-download.png`. Pass when the decoded duration is within the configured tolerance and the report states the configured six-hour limit.
- [ ] Lane 8. An interrupted transfer in the interruption case leaves no partial file. Save `interruption-cleanup.png`. Pass when the case passes and no file from that case remains in trial storage.
- [ ] Lane 9. A rerun with a fresh request succeeds after the first run. Save `rerun-fresh-request.png`. Pass when the second run does not reuse a tunnel URL and reaches the same verdict.
- [ ] Lane 10. Unrelated Vanta services are untouched. Save `unrelated-services-intact.png`. Pass when the container list, the port listeners, the Caddy configuration, and the Tailscale Serve and Funnel status match the pre-trial check except for the trial container.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Cobalt processing wall time and output byte count per fixture at the trial's `audioFormat: best` setting. Trunk has no Cobalt deployment, so this is an absolute budget on the work the unit adds.
- [ ] Probe. Run `scripts/smoke-cobalt.mjs` twice per fixture on the same host, interleaved, and read the per-case processing time and byte count from the report.
- [ ] Baseline. Record the first measured processing time and byte count per fixture before the second run.
- [ ] Rule. Fail when any single fixture exceeds 30 minutes of processing wall time, when output size exceeds 520 MiB, or when a second run of the same fixture differs from the first by more than 25 percent in processing time.

**Review gate.** None. U1 is not review-gated, because it adds no interaction. The operator's gate is the deployment authorization that the ticket's execution gate requires before any remote mutation.

**Merge.**

- [ ] Operator authorization for the remote deployment recorded before the first `docker compose` command.
- [ ] `bun run check` exits zero at the unit head.
- [ ] The evidence file is committed, and `deploy/cobalt/keys.json` and `deploy/cobalt/*.report.json` stay untracked.
- [ ] Ticket 2 is closed with a resolution comment linking the evidence file, the SHA, and the go or no-go recommendation.
- [ ] Fast-forward onto `main`.

## Build the native foundation and browse the Library (U2)

**Depends on.** U1. Ticket 4. Blocks U3, U4, U5, and U6.

**Files.**

- [ ] Create `apps/native/project.yml` as the xcodegen specification for one multiplatform app with iOS 26 and macOS 26 deployment targets.
- [ ] Create `apps/native/Orbis/` holding the app entry point, domain models, the HTTP client, the connection settings screen, and the Library and Search destinations.
- [ ] Create `apps/native/OrbisTests/` and `apps/native/OrbisUITests/`.
- [ ] Create `scripts/native-lanes.mjs` as the simulator control skill, and `scripts/native-macos-drive.mjs` as the macOS control skill.
- [ ] Edit `apps/server/src/app.ts` and `apps/server/src/library.ts` for the native list contract and the identity boundary.
- [ ] Edit `packages/contracts/src/index.ts` for the extended Set shape.
- [ ] Edit `.gitignore` for the generated project and derived data.
- [ ] Delete `apps/ios/README.md` and record the move in `README.md`.

**Build.**

- [ ] Set the platform-conditional unit test host in `apps/native/project.yml`, because a multiplatform target receives the iOS bundle path for both destinations by default. Use the `[sdk=macosx*]` condition recorded in Appendix A.
- [ ] Define the extended Set contract in `packages/contracts/src/index.ts` with creator, artwork location, duration, metadata state, download state, Retained Audio metadata, Playback Position, Listen count, Finish count, and last-listened date.
- [ ] Add a schema migration in `apps/server/src/library.ts` that preserves existing rows. The current schema has no migration mechanism, so add one before the first new column.
- [ ] Implement the trusted native identity boundary so the service stays private behind Tailscale and rejects untrusted direct access, per the `architect` decision gate below.
- [ ] Implement first launch connection setup in `apps/native/Orbis/` that accepts one Vanta HTTPS address, persists it, and tests health before entering the app.
- [ ] Implement the Library destination with artwork-led rows showing identity, source, tags, Playback Position, and Download state.
- [ ] Implement the Search destination over the existing title, tag, and Source Link matching, and add creator once U3 enriches it.
- [ ] Implement the empty, loading, unavailable, and no-results states so each names its recovery action.
- [ ] Implement adaptive navigation, a tab bar on iPhone and a sidebar on iPad and macOS, with standard search and toolbars.
- [ ] Gate the identity design through `architect` before writing server code. Record the chosen shape in `docs/adr/0004-native-service-identity.md`.
- [ ] Do not add an Orbis account system, a custom glass surface, or a token in a URL query string.

**You see.**

- [ ] Launching the app on a fresh simulator shows the connection screen, then the Library after a successful health check.
- [ ] Stopping the server produces an unavailable state naming the recovery action, not an empty library.
- [ ] `xcrun xcresulttool export attachments` writes each lane's screenshot with its attachment name.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests in `apps/server/src/app.test.ts` for the extended list contract, the migration of existing rows, and rejection of a non-tailnet Host and a browser Origin. Run `bun run --filter @orbis/server test`.
- [ ] Add unit tests in `apps/native/OrbisTests/` for address persistence, the health probe against a stubbed URL protocol, and the row view model state machine. Run `bun run native:lanes --unit`.
- [ ] Add a UI test in `apps/native/OrbisUITests/` that drives connection setup, Library loading, search filtering, and both failure states. Run `bun run native:lanes --journeys`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is one iOS simulator and one macOS window against a temporary local server.

- [ ] Lane 1. Regression lane against trunk. Run the same Library list request at trunk and head against a temporary server with the same seeded data. Trunk serves the current Set shape, so record that fact and gate the extended row fields the user waits for plus the existing behaviour of newest-first ordering. Save `library-list-trunk-vs-head.png`. Pass when trunk returns the current fields, head returns the extended fields, and both keep newest-first ordering.
- [ ] Lane 2. First launch accepts the address and reaches the Library. Save `first-launch-connected.png`. Pass when the Library shows rows after the health check with no restart.
- [ ] Lane 3. The address persists across a relaunch. Save `address-persisted.png`. Pass when the second launch skips setup and loads the Library.
- [ ] Lane 4. An unreachable address produces a recovery-titled error. Save `unavailable-state.png`. Pass when the message names the address and the recovery action, and a retry succeeds once the server returns.
- [ ] Lane 5. An empty library is distinguishable from no results. Save `empty-vs-no-results.png`. Pass when an empty library and a filter with no matches show different messages.
- [ ] Lane 6. Artwork-led rows show the required fields. Save `row-anatomy.png`. Pass when a row shows title, source, at least one tag, Playback Position when present, and Download state when present.
- [ ] Lane 7. Search matches title, tag, and Source Link. Save `search-matches.png`. Pass when three seeded Sets are each found by one of those three fields and only by that field.
- [ ] Lane 8. iPhone, iPad, and macOS navigation match the platform. Save `navigation-adaptive.png`. Pass when iPhone shows a tab bar, and iPad and macOS show a sidebar, at the platform's default window size.
- [ ] Lane 9. The macOS window is reachable through the Accessibility API. Save `macos-ax-tree.txt`. Pass when the window title and the Library rows appear in the tree, and the lane records that screenshot capture is blocked pending the Screen Recording grant.
- [ ] Lane 10. Accessibility holds up. Save `accessibility-states.png`. Pass when VoiceOver labels exist for rows and controls, the largest Dynamic Type size does not clip a row, every target is at least 44 by 44 points, and dark appearance, Increased Contrast, Reduce Transparency, and Reduce Motion all render.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `GET /sets` response time for a seeded 500 Set library, and cold launch to first rendered row on the iPhone simulator.
- [ ] Probe. Run the same request loop and the same cold launch against trunk and head, interleaved, from `scripts/native-lanes.mjs`.
- [ ] Baseline. Record the trunk response time and trunk launch time first. Trunk has no native app, so record the trunk server response time only and label the launch metric as new work.
- [ ] Rule. Fail when head `GET /sets` exceeds the trunk value by more than 50 percent, when a 500 Set response exceeds 250 ms locally, or when cold launch to first row exceeds 2.5 seconds on the simulator.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 6, 7, and 8 screenshots into `docs/plans/media/u2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of connection setup, browsing, search, and the failure state on a simulator. Save it as `docs/plans/media/u2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA from `/skill:technical-writing` reviewed prose and the swarm lanes.
- [ ] `bun run check` exits zero.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 4 is closed with the receipts.
- [ ] The identity decision is recorded in `docs/adr/0004-native-service-identity.md`.

## Save metadata-enriched Sets (U3)

**Depends on.** U2. Ticket 5. Blocks U12 and U13.

**Files.**

- [ ] Create `apps/server/src/metadata.ts` with a narrow Effect service for the two providers and their typed failures.
- [ ] Create `apps/server/src/metadata.test.ts` with controlled provider fakes.
- [ ] Edit `apps/server/src/app.ts` and `apps/server/src/library.ts` for the enrichment save path, the retry route, and the user-edited title flag.
- [ ] Edit `packages/contracts/src/index.ts` for the metadata state and creator fields.
- [ ] Create the save flow views under `apps/native/Orbis/Save/`.
- [ ] Edit `docs/adr/0005-metadata-providers.md` with the provider contract.

**Build.**

- [ ] Implement the YouTube provider against the YouTube Data API with a server-held key, and the SoundCloud provider against oEmbed.
- [ ] Save a valid Source Link before enrichment, so a provider failure never loses the Set, and mark the metadata state failed.
- [ ] Initialize the editable title from source metadata, and record a user edit so a later retry never overwrites it.
- [ ] Add the Retry Metadata action and its route.
- [ ] Implement the native save flow that starts with one Source Link field and reveals optional organization controls only after validation.
- [ ] Keep canonical duplicate detection authoritative and return clear duplicate feedback.
- [ ] Add creator to search matching after enrichment.
- [ ] Ingest the five initial Source Links from ticket 3 as a seed, without building a general import system.
- [ ] Keep the YouTube API key on Vanta only, never in the app bundle or the repository.

**You see.**

- [ ] Saving a link with enrichment unavailable produces a Set with a temporary title and a Retry Metadata action.
- [ ] A retry after a manual title edit leaves the edited title intact.
- [ ] A duplicate save returns the duplicate result and does not overwrite the stored Set.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for enrichment success, enrichment failure, retry, title preservation, duplicate save, and creator search, all against controlled provider fakes and a temporary SQLite database. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for the save flow's validation and optional-control reveal. Run `bun run native:lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is the iOS simulator save flow against a temporary server with fake providers.

- [ ] Lane 1. Regression lane against trunk. Save a Set with a title and tags at trunk and at head. Trunk has manual metadata only, so record that fact and gate the enriched save behaviour the user waits for, a populated creator and duration without retyping. Save `save-trunk-vs-head.png`. Pass when trunk stores the typed title, and head stores the typed title plus enriched creator, artwork, and duration.
- [ ] Lane 2. The save flow begins with one field. Save `save-single-field.png`. Pass when only the Source Link field is visible before validation.
- [ ] Lane 3. Optional controls appear only after validation. Save `save-optional-reveal.png`. Pass when tag, Playlist, and Download intent controls appear after a valid link and not before.
- [ ] Lane 4. YouTube enrichment records title, creator, artwork, and duration. Save `enrich-youtube.png`. Pass when all four appear from the fake provider.
- [ ] Lane 5. SoundCloud enrichment records equivalent metadata. Save `enrich-soundcloud.png`. Pass when title, creator, and artwork appear, and duration appears when the provider supplies it.
- [ ] Lane 6. Provider failure preserves the Set. Save `enrich-failure-retained.png`. Pass when the Set exists with a temporary title and a Retry Metadata action.
- [ ] Lane 7. Retry after a manual edit keeps the edited title. Save `retry-preserves-title.png`. Pass when the title is unchanged and the other metadata fills in.
- [ ] Lane 8. A duplicate save reports clearly and does not overwrite. Save `duplicate-feedback.png`. Pass when the stored Set's fields are byte-identical before and after.
- [ ] Lane 9. Search finds an enriched Set by creator. Save `search-by-creator.png`. Pass when a creator-only query returns exactly the enriched Sets.
- [ ] Lane 10. The five seeded Source Links exist without a manual import step. Save `seed-ingested.png`. Pass when all five are present with metadata resolved or a failed state recorded, and no import command exists.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server time for one save with fake providers, and for one metadata retry. Trunk has no enrichment, so this is an absolute budget on the added work plus the user-visible end state.
- [ ] Probe. Run 20 sequential saves and 20 retries at trunk and head against the fake providers, interleaved, and report the median and the maximum.
- [ ] Baseline. Record the trunk save time first, which measures validation, storage, and duplicate handling only.
- [ ] Rule. Fail when head save time exceeds the trunk value by more than 200 ms, when a single save exceeds 1.5 seconds with a fake provider, or when a retry exceeds 1.5 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 6, and 7 screenshots into `docs/plans/media/u3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of saving a YouTube link, a SoundCloud link, a provider failure, and a retry. Save it as `docs/plans/media/u3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero, and `bun run --filter @orbis/server diagnostics` reports no Effect issue.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 5 is closed with the receipts.

## Manage saved Sets natively (U4)

**Depends on.** U2. Ticket 6.

**Files.**

- [ ] Create `apps/native/Orbis/SetDetail/` holding detail, title and tag editing, and the delete confirmation.
- [ ] Create `apps/server/src/delete.test.ts` for the cascade.
- [ ] Edit `apps/server/src/library.ts` for the cascade delete across playlists, queue, position, statistics, and retained media.
- [ ] Edit `apps/server/src/app.ts` for the delete and edit routes.

**Build.**

- [ ] Implement title editing and whole-tag replacement from Set details.
- [ ] Implement Open Source Link as a platform-standard action that leaves the app.
- [ ] Implement deletion behind explicit confirmation, naming Retained Audio removal when the Set has any.
- [ ] Implement the cascade so a delete removes Playlist membership, Listening Queue entries, Playback Position, statistics, and Retained Audio.
- [ ] Preserve the visible Set on a server error and offer a retryable result.
- [ ] Use contextual menus and destructive styling that match iOS and macOS conventions.

**You see.**

- [ ] Deleting a Set with Retained Audio names the audio removal in the confirmation.
- [ ] After a delete, the Set is gone from the Library and from every Playlist that contained it, and no Retained Audio file remains.
- [ ] A failed edit leaves the previous title visible and offers a retry.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for title edit, tag replacement, delete cascade across every dependent table, delete of a Set with no Retained Audio, and the error path that preserves the row. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for the confirmation state machine, including the Retained Audio warning. Run `bun run native:lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Edit a title and replace tags at trunk and head through the HTTP boundary. Trunk already supports both, so gate that head keeps them byte-identical plus the new delete cascade the user waits for. Save `manage-trunk-vs-head.png`. Pass when trunk and head produce the same stored title and tags, and head additionally removes dependent rows on delete.
- [ ] Lane 2. Editing the title persists across a relaunch. Save `title-edit-persisted.png`. Pass when the edit survives a relaunch.
- [ ] Lane 3. Replacing tags updates suggestions. Save `tags-replaced.png`. Pass when the suggestion list reflects new tags and drops removed ones.
- [ ] Lane 4. Opening the Source Link leaves the app and reaches the allowlisted URL. Save `open-source-link.png`. Pass when the platform handler receives the exact normalized Source Link.
- [ ] Lane 5. Deletion confirmation names the consequences. Save `delete-confirmation.png`. Pass when the confirmation appears, is cancelable, and names Retained Audio removal when applicable.
- [ ] Lane 6. Cancelling the confirmation changes nothing. Save `delete-cancelled.png`. Pass when the Set, its Playlists, and its audio are unchanged.
- [ ] Lane 7. Deletion removes every dependent row. Save `delete-cascade.png`. Pass when Playlist membership, queue entries, position, statistics, and Retained Audio are all absent afterwards, checked by a read-only database query.
- [ ] Lane 8. A delete of a Set with no Retained Audio does not claim audio removal. Save `delete-without-audio.png`. Pass when the confirmation omits the audio warning.
- [ ] Lane 9. A server error preserves the visible Set. Save `delete-error-preserved.png`. Pass when the Set remains visible with a retryable message after the server fails the request.
- [ ] Lane 10. Destructive and contextual actions follow platform conventions. Save `platform-conventions.png`. Pass when macOS shows the actions in a context menu and iOS in a swipe or menu, with system destructive styling.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server time for one delete of a Set that belongs to 20 Playlists, and the time for one tag replacement on a Set with 20 tags.
- [ ] Probe. Run 20 deletes and 20 tag replacements at trunk and head against a temporary database with the same seed, interleaved.
- [ ] Baseline. Record trunk tag replacement time first, and record that trunk has no delete cascade to measure.
- [ ] Rule. Fail when head tag replacement exceeds the trunk value by more than 100 ms, or when a 20 Playlist delete exceeds 400 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 5, 7, 8, and 10 screenshots into `docs/plans/media/u4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a title edit, a tag replacement, a cancelled delete, and a confirmed delete with Retained Audio. Save it as `docs/plans/media/u4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 6 is closed with the receipts.

## Organize Sets into Playlists natively (U5)

**Depends on.** U2. Ticket 7. Blocks U10.

**Files.**

- [ ] Create `apps/native/Orbis/Playlists/` holding the list, create, membership, reorder, and removal views.
- [ ] Edit `apps/server/src/library.ts` for Playlist creation validation and reorder writes.
- [ ] Edit `apps/server/src/app.ts` for the Playlist routes the native client needs.
- [ ] Edit `packages/contracts/src/index.ts` for the Playlist contract.

**Build.**

- [ ] Make Playlists a primary destination on iPhone, iPad, and macOS with standard navigation.
- [ ] Implement creation with a required unique name and the existing limits surfaced and recoverable.
- [ ] Implement adding existing Sets and showing them in Playlist order.
- [ ] Implement reordering with the interaction each platform expects, drag on iOS and macOS lists.
- [ ] Implement removal of membership that preserves the Library entry.
- [ ] Keep the existing five hundred Set per Playlist limit and the existing validation messages.
- [ ] Do not introduce folders or disk hierarchy, which ticket 1 explicitly deferred.

**You see.**

- [ ] Reordering a Playlist persists the new order across a relaunch and across both platforms.
- [ ] Removing a Set from a Playlist leaves it in the Library.
- [ ] A duplicate Playlist name is rejected with a recoverable message.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for Playlist creation, duplicate name rejection, ordering writes, membership removal that preserves the Set, and the limit. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for the reorder and removal view models. Run `bun run native:lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Create a Playlist and write an order at trunk and head through the HTTP boundary. Trunk already supports both, so gate that head preserves the stored order exactly and adds the native destination the user waits for. Save `playlists-trunk-vs-head.png`. Pass when the stored order is identical at trunk and head.
- [ ] Lane 2. Playlists is a primary destination on all three platforms. Save `playlists-destination.png`. Pass when iPhone, iPad, and macOS each reach Playlists in one step from the primary navigation.
- [ ] Lane 3. Creating a valid Playlist succeeds. Save `playlist-created.png`. Pass when the new Playlist appears in the list and persists across a relaunch.
- [ ] Lane 4. A duplicate name is rejected recoverably. Save `playlist-duplicate-name.png`. Pass when the error names the conflict and the form keeps the typed text.
- [ ] Lane 5. Adding existing Sets shows them in Playlist order. Save `playlist-add-sets.png`. Pass when the displayed order matches the stored `setIds` order.
- [ ] Lane 6. Reordering persists. Save `playlist-reordered.png`. Pass when a relaunch shows the new order and a read-only database query matches it.
- [ ] Lane 7. A Set can belong to two Playlists. Save `playlist-multi-membership.png`. Pass when one Set appears in two orders with independent positions.
- [ ] Lane 8. Removing membership preserves the Set. Save `playlist-removal-preserves-set.png`. Pass when the Set is absent from the Playlist and present in the Library.
- [ ] Lane 9. The limit and validation stay visible and recoverable. Save `playlist-limit.png`. Pass when the limit error is shown and the Playlist is unchanged.
- [ ] Lane 10. Ordering survives a cross-platform round trip. Save `playlist-cross-platform.png`. Pass when an order written on the simulator is shown identically in the macOS window, verified through the Accessibility tree.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server time to write a reorder for a 500 Set Playlist, and to load one in the native list.
- [ ] Probe. Write 20 reorders and load the Playlist 20 times at trunk and head against the same seed, interleaved.
- [ ] Baseline. Record the trunk reorder write time first.
- [ ] Rule. Fail when a 500 Set reorder exceeds 500 ms, when a native Playlist load exceeds 400 ms, or when head reorder write time exceeds the trunk value by more than 50 percent.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 5, 6, 7, and 10 screenshots into `docs/plans/media/u5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of creating a Playlist, adding Sets, reordering, and removing membership. Save it as `docs/plans/media/u5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 7 is closed with the receipts.

## Select an Apple-compatible Cobalt output (U6)

**Depends on.** U1 and U2. Ticket 10.

**Files.**

- [ ] Create `docs/adr/0006-retained-audio-format.md` recording the chosen default and every rejected alternative.
- [ ] Create `scripts/measure-cobalt-audio.mjs` reusing the smoke check's tunnel and ffprobe logic for per-format measurement.
- [ ] Create `scripts/cobalt-audio-formats.mjs` holding the candidate list so both the measurement script and the ADR agree.
- [ ] Edit `docs/ops/cobalt-trial-evidence.md` with the per-format measurements.

**Build.**

- [ ] Extend the measurement script to request each candidate format through the private Cobalt deployment and to record source codec and bitrate, output codec and container, byte count, conversion wall time, and Vanta CPU impact per fixture.
- [ ] Reuse the same permitted fixtures from U1, including the multi-hour Set, so the measurement is comparable.
- [ ] Verify complete decoding and expected duration independently with `ffmpeg` and `ffprobe`.
- [ ] Verify AVFoundation playback and seeking for each candidate with the range server from Appendix A, on macOS and on the iOS simulator.
- [ ] Record the byte range behaviour each candidate needs. Appendix A already establishes that every read is a range request.
- [ ] Reject any candidate that fails complete decoding, duration match, or AVFoundation playback and seeking.
- [ ] Choose one default and document the measured reason, with no user-facing quality setting.
- [ ] Keep every live third-party check opt-in and out of ordinary CI.

**You see.**

- [ ] `docs/adr/0006-retained-audio-format.md` answers with one measured default, the rejected alternatives, and the numbers behind each.
- [ ] The measurement script needs the network and never runs in `bun run check`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add offline tests for `scripts/measure-cobalt-audio.mjs` covering response parsing, candidate iteration, and rejection of a `picker` or `error` response. Run `bun run test:cobalt`.
- [ ] Confirm the range server from Appendix A still passes for every playable candidate with `swift probe.swift`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is the Vanta Cobalt deployment plus AVFoundation on macOS and the iOS simulator.

- [ ] Lane 1. Regression lane against trunk. Run the U1 trial fixtures at trunk and at head. Trunk has no format measurement, so record that fact and gate the measured default the operator waits for, one format with decoding, duration, and AVFoundation evidence. Save `format-trunk-vs-head.png`. Pass when trunk records `best` only and head records each candidate separately.
- [ ] Lane 2. A YouTube Set converts in every candidate format. Save `youtube-candidates.png`. Pass when each candidate produces a complete, decodable file with a matching duration.
- [ ] Lane 3. A SoundCloud track converts in every candidate format. Save `soundcloud-candidates.png`. Pass when the same predicates hold.
- [ ] Lane 4. The multi-hour Set converts in the surviving candidates. Save `long-set-candidates.png`. Pass when duration matches within tolerance and decoding completes.
- [ ] Lane 5. Per-format size and conversion time are recorded. Save `format-measurements.png`. Pass when the table has source codec, output codec, container, bytes, and wall time for every candidate and fixture.
- [ ] Lane 6. Vanta CPU impact is recorded per candidate. Save `vanta-cpu-impact.png`. Pass when each candidate has a recorded CPU observation from the host.
- [ ] Lane 7. AVFoundation plays each surviving candidate on macOS. Save `avfoundation-macos.png`. Pass when `probe.swift` reports `RESULT=PASS` for each.
- [ ] Lane 8. AVFoundation plays and seeks each surviving candidate on the iOS simulator. Save `avfoundation-ios.png`. Pass when a simulator app plays each candidate and reports a seek to the midpoint within tolerance.
- [ ] Lane 9. Byte range behaviour is identified per candidate. Save `range-behaviour.png`. Pass when the range server log shows the request pattern each candidate needs and no candidate needs a full-file read.
- [ ] Lane 10. No quality setting appears in the native UI. Save `no-quality-setting.png`. Pass when no format, bitrate, or transcoding control exists in the app or its settings.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Conversion wall time, output byte count, and peak Vanta CPU per candidate, measured on the same fixture as U1's longest Set.
- [ ] Probe. Run each candidate twice per fixture on the host, interleaved, reading time and bytes from the measurement report and CPU from the host.
- [ ] Baseline. Record the U1 `best` measurement for the same fixture first, so every candidate is compared against the format the trial already used.
- [ ] Rule. Reject a candidate when it exceeds 30 minutes of conversion for the long fixture, when its output exceeds 520 MiB, when a second run differs by more than 25 percent in wall time, or when peak CPU during conversion exceeds 90 percent of the host core count.

**Review gate.** None. U6 is not review-gated, because it adds no interaction. Its gate is the `interrogate` review named in Appendix D, which is a decision review rather than a UI review.

**Merge.**

- [ ] `interrogate` recorded its verdict on the format decision, with the rejected alternatives and the numbers.
- [ ] `bun run check` exits zero, and the measurement scripts stay out of the default test path.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 10 is closed with the ADR linked.

## Download one Set end to end (U7)

**Depends on.** U3 and U6. Ticket 11. Blocks U8 and U9.

**Files.**

- [ ] Create `apps/server/src/downloads.ts` as the SQLite-backed job store and state machine.
- [ ] Create `apps/server/src/cobalt.ts` as the narrow Cobalt client service.
- [ ] Create `apps/server/src/media.ts` as the Retained Audio store with generated safe paths.
- [ ] Create `apps/server/src/download-worker.ts` as the single scoped Effect worker.
- [ ] Create `apps/server/src/downloads.test.ts` with a controlled Cobalt fake.
- [ ] Edit `apps/server/src/app.ts` for request, status, and media routes.
- [ ] Edit `apps/server/src/library.ts` for the download state columns and their migration.
- [ ] Create `apps/native/Orbis/Downloads/` for the Download action and its four states.
- [ ] Edit `docs/adr/0002-persist-download-jobs.md` to record the implemented decision.

**Build.**

- [ ] Persist a job in SQLite before acknowledging the request, and treat SQLite as authoritative, with the Effect Queue only as a wake-up.
- [ ] Implement one scoped worker that processes jobs sequentially, with no second worker.
- [ ] Implement the Cobalt client as a narrow Effect service with typed failures, and supply the implementation as a Layer at the application boundary.
- [ ] Stream the transfer to disk through the generated safe path, enforcing configured size, duration, and timeout bounds.
- [ ] Use the U6 default format and the managed media directory.
- [ ] Expose queued, downloading, ready, and failed states to both native apps.
- [ ] Never start a Download from saving. Only an explicit action creates Retained Audio.
- [ ] Do not buffer a complete file in memory at any point.

**You see.**

- [ ] A Download request returns immediately with a queued job that survives a server restart.
- [ ] A controlled Cobalt fake drives a job from queued to ready, and the file appears in the managed media directory.
- [ ] A failed job leaves no partial file behind.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for the request, the persisted state before acknowledgement, the four visible states, the failure path, and cleanup of partial output, all with a controlled Cobalt fake and a temporary database and media directory. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for the four Download states and their transitions. Run `bun run native:lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is the iOS simulator against a temporary server with a controlled Cobalt fake, plus one opt-in lane against the real Vanta Cobalt.

- [ ] Lane 1. Regression lane against trunk. Save a Set at trunk and at head. Trunk has no Download concept, so record that fact and gate the behaviour the user waits for, saving never downloads, plus the explicit Download path reaching ready. Save `download-trunk-vs-head.png`. Pass when trunk has no download state and head reaches ready only after an explicit action.
- [ ] Lane 2. Saving a Set does not start a Download. Save `save-does-not-download.png`. Pass when the Set's download state stays absent after a save.
- [ ] Lane 3. The Download action persists a job before acknowledging. Save `job-persisted.png`. Pass when a read-only database query shows the job row before the client receives its response.
- [ ] Lane 4. The worker processes jobs one at a time. Save `sequential-worker.png`. Pass when two queued jobs never overlap in the state log.
- [ ] Lane 5. The four states appear in the native app. Save `download-states-native.png`. Pass when queued, downloading, ready, and failed are each observed on screen.
- [ ] Lane 6. A ready Set has Retained Audio in the managed directory with the U6 default format. Save `retained-audio-created.png`. Pass when `ffprobe` reports the chosen codec and container and the path is inside the managed directory.
- [ ] Lane 7. A failed job leaves no partial file. Save `failure-cleanup.png`. Pass when the controlled fake fails the transfer and no file remains for that Set.
- [ ] Lane 8. Size, duration, and timeout bounds are enforced. Save `bounds-enforced.png`. Pass when a transfer exceeding the byte bound is stopped and recorded as a typed failure.
- [ ] Lane 9. A queued job survives a server restart. Save `job-survives-restart.png`. Pass when the job is still queued after a restart and then completes.
- [ ] Lane 10. Opt-in lane against real Vanta Cobalt. Save `real-cobalt-download.png`. Pass when one permitted Set downloads to ready with a complete, decodable file. Record that this lane is opt-in and outside ordinary CI.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Peak server process resident memory while downloading a file larger than 200 MiB, and end-to-end time from request to ready.
- [ ] Probe. Run the same download against the controlled Cobalt fake at trunk and head, sampling resident memory every 250 ms and reporting the peak.
- [ ] Baseline. Record trunk's peak resident memory on the same route first, which has no transfer at all.
- [ ] Rule. Fail when head peak resident memory exceeds the trunk idle value by more than 64 MiB, or when a 200 MiB transfer exceeds five minutes against the fake.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 5, and 7 screenshots into `docs/plans/media/u7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of an explicit Download from queued to ready, including one failure. Save it as `docs/plans/media/u7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero and the opt-in lane is excluded from it.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 11 is closed with the receipts.

## Make Downloads recoverable and controllable (U8)

**Depends on.** U7. Ticket 12. Blocks U9.

**Files.**

- [ ] Edit `apps/server/src/downloads.ts` for cancel, retry, recovery, and idempotency.
- [ ] Edit `apps/server/src/download-worker.ts` for interruption recovery on start.
- [ ] Edit `apps/server/src/media.ts` for partial file removal.
- [ ] Edit `apps/server/src/app.ts` for the cancel and retry routes.
- [ ] Edit `apps/native/Orbis/Downloads/` for cancel, retry, and progress.
- [ ] Create `apps/server/src/download-recovery.test.ts`.

**Build.**

- [ ] Implement cancel for queued and active work, with active cancellation removing partial media.
- [ ] Implement explicit retry for failed and canceled jobs.
- [ ] Remove partial media on cancellation, timeout, provider failure, and process interruption.
- [ ] On start, resume persisted queued jobs and move interrupted jobs into one documented recoverable state.
- [ ] Make repeated requests idempotent so one Set can never have two competing Retained Audio files.
- [ ] Make progress observable without buffering the complete file in memory.
- [ ] Map every recovery error to typed, actionable native feedback.
- [ ] Do not add Redis, an external queue service, a distributed worker, or a second downloader.

**You see.**

- [ ] Cancelling an active job removes its partial file within one second.
- [ ] Restarting the server while a job is downloading moves that job to the documented recoverable state, never to a phantom downloading state.
- [ ] Two concurrent requests for the same Set produce one job and one file.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for cancellation of queued and active work, retry, restart recovery, duplicate request idempotency, and partial cleanup after each failure class. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for the cancel and retry affordances and their error messages. Run `bun run native-lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Request a Download at trunk and at head. Trunk has no cancel or retry, so record that fact and gate the controllable behaviour the user waits for plus the unchanged happy path to ready. Save `recovery-trunk-vs-head.png`. Pass when the happy path still reaches ready and head adds cancel and retry.
- [ ] Lane 2. Cancelling a queued job stops it before it starts. Save `cancel-queued.png`. Pass when the job never enters downloading and produces no file.
- [ ] Lane 3. Cancelling an active job removes the partial file. Save `cancel-active.png`. Pass when the job is canceled and no file for that Set remains.
- [ ] Lane 4. Retrying a failed job succeeds. Save `retry-failed.png`. Pass when the same job reaches ready without creating a second job.
- [ ] Lane 5. Retrying a canceled job succeeds. Save `retry-canceled.png`. Pass when the job reaches ready and only one file exists.
- [ ] Lane 6. A restart during download reaches the documented recoverable state. Save `restart-recovery.png`. Pass when the job is neither queued as if nothing happened nor stuck in downloading, and retry from that state reaches ready.
- [ ] Lane 7. Duplicate requests stay idempotent. Save `idempotent-requests.png`. Pass when ten concurrent requests produce exactly one job row and one file.
- [ ] Lane 8. A timeout removes partial media. Save `timeout-cleanup.png`. Pass when a transfer exceeding the timeout is stopped and the partial file is removed.
- [ ] Lane 9. Progress is observable without full buffering. Save `progress-observable.png`. Pass when progress advances during the transfer and peak resident memory stays inside the U7 budget.
- [ ] Lane 10. Every recovery error maps to actionable feedback. Save `recovery-feedback.png`. Pass when each typed failure shows a distinct message naming its recovery.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a cancel request to the partial file being gone, and time from a restart to a recovered job's next state.
- [ ] Probe. Cancel an active transfer 20 times and restart the server 20 times at trunk and head against the controlled fake, interleaved.
- [ ] Baseline. Record trunk cancel and restart recovery first. Trunk has neither behavior, so record that both are absent and treat the metric as new work with an absolute budget.
- [ ] Rule. Fail when a cancel takes longer than one second to remove partial media, or when restart recovery takes longer than five seconds to reach the documented state.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3, 4, 6, and 8 screenshots into `docs/plans/media/u8-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a cancel, a retry, and one restart recovery. Save it as `docs/plans/media/u8-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 12 is closed with the receipts.

## Play Retained Audio with system media controls (U9)

**Depends on.** U8. Ticket 13. Blocks U10.

**Files.**

- [ ] Create `apps/server/src/media-range.test.ts` for the authorized range endpoint.
- [ ] Edit `apps/server/src/media.ts` and `apps/server/src/app.ts` for the authorized streaming endpoint with byte range semantics.
- [ ] Create `apps/native/Orbis/Playback/` holding the shared player, the mini-player, Now Playing, and the remote command bridge.
- [ ] Create `apps/native/OrbisUITests/PlaybackUITests.swift`.
- [ ] Create `scripts/serve-test-media.mjs` as the deterministic local media server for lanes, reusing the Appendix A range server.

**Build.**

- [ ] Implement the authorized media endpoint with the methods, content metadata, and byte ranges AVFoundation requires.
- [ ] Implement the shared player so it streams and seeks reliably in long Sets.
- [ ] Implement a persistent mini-player that survives Library, Playlist, and Search navigation and expands into Now Playing without losing navigation or scroll context.
- [ ] Implement iOS background playback with the required background mode.
- [ ] Implement Now Playing metadata, remote commands, headset controls, keyboard controls, and macOS media keys.
- [ ] Keep Open Source Link available separately from playback.
- [ ] Distinguish network, unavailable media, and unsupported output failures.
- [ ] Do not imitate a glass surface or add a custom navigation system.

**You see.**

- [ ] A multi-hour Set starts playing within a second over the local network and seeks to the midpoint reliably.
- [ ] The mini-player stays visible while browsing and returns to the same scroll position when collapsed.
- [ ] Lock Screen and Control Center show the Set, its artwork, and the Playback Position, and their controls affect playback.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for the media endpoint covering authentication, `HEAD`, a full request, a suffix range, an open-ended range, a mid-file range, and an unsatisfiable range returning 416 with `content-range`. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for player state, failure classification, and the mini-player collapse behaviour. Run `bun run native:lanes --unit`.
- [ ] Add a deterministic playback test in `apps/native/OrbisUITests/PlaybackUITests.swift` against `scripts/serve-test-media.mjs`. Run `bun run native:lanes --playback`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is the iOS simulator with deterministic local media, plus one macOS lane.

- [ ] Lane 1. Regression lane against trunk. Open a Set at trunk and at head. Trunk has no playback, so record that fact and gate the behaviour the user waits for, audio that starts, seeks, and keeps playing in the background. Save `playback-trunk-vs-head.png`. Pass when trunk offers only Open Source Link and head plays.
- [ ] Lane 2. Playback starts from Retained Audio. Save `playback-starts.png`. Pass when audio starts and time advances.
- [ ] Lane 3. Seeking in a long Set lands within two seconds of the target. Save `playback-seek-long-set.png`. Pass when a seek to the midpoint and back both land inside tolerance.
- [ ] Lane 4. Range behaviour matches AVFoundation's needs. Save `playback-ranges.png`. Pass when the media server log shows range requests only, in the Appendix A pattern.
- [ ] Lane 5. The mini-player persists across navigation. Save `miniplayer-persists.png`. Pass when audio continues and the mini-player remains visible in Library, Playlist, and Search.
- [ ] Lane 6. The mini-player expands without losing context. Save `nowplaying-expands.png`. Pass when Now Playing opens and collapsing returns to the same destination and scroll offset.
- [ ] Lane 7. Background playback continues on iOS. Save `background-playback.png`. Pass when audio continues after leaving the app and time has advanced.
- [ ] Lane 8. System controls drive playback. Save `system-controls.png`. Pass when Lock Screen or Control Center shows the Set and artwork and a pause or resume from there changes playback state.
- [ ] Lane 9. Failure classes are distinguishable. Save `playback-failures.png`. Pass when a stopped server, a missing file, and an unsupported output each show a different message.
- [ ] Lane 10. The macOS window plays and reports Now Playing. Save `macos-playback-ax.txt`. Pass when playback starts in the macOS window and the Now Playing state appears in the Accessibility tree.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a play action to first audio, and the maximum seek latency in a file longer than two hours.
- [ ] Probe. Run the same play and seek sequence ten times at trunk and head against `scripts/serve-test-media.mjs`, interleaved, recording both times.
- [ ] Baseline. Record trunk's time first, which measures only the request and view transition because trunk has no playback, and label the metric as predominantly new work.
- [ ] Rule. Fail when time to first audio exceeds 1.5 seconds, or when a seek in a file longer than two hours exceeds 2 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 5, 6, and 8 screenshots into `docs/plans/media/u9-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of starting a long Set, browsing with the mini-player visible, expanding to Now Playing, seeking, and pausing from Lock Screen. Save it as `docs/plans/media/u9-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero, and the playback lane uses only local deterministic media.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 13 is closed with the receipts.

## Synchronize the Listening Queue and Playback Position (U10)

**Depends on.** U5 and U9. Ticket 14. Blocks U11.

**Files.**

- [ ] Create `apps/server/src/queue.ts` and `apps/server/src/queue.test.ts`.
- [ ] Edit `apps/server/src/library.ts` for the queue and position tables.
- [ ] Edit `apps/server/src/app.ts` for the queue and position routes.
- [ ] Create `apps/native/Orbis/Queue/` for queue actions and position reporting.
- [ ] Edit `packages/contracts/src/index.ts` for the queue contract.

**Build.**

- [ ] Persist one ordered Listening Queue and one active Set on Vanta.
- [ ] Admit only Sets with Retained Audio into the queue.
- [ ] Make tapping a playable Set active while preserving the remaining queue.
- [ ] Implement Play Next as an insert after the active Set and Add to Queue as an append.
- [ ] Make playing a Playlist replace the queue with playable members in Playlist order.
- [ ] Confirm only when replacing an actively playing queue.
- [ ] Bound Playback Position updates and synchronize them across platforms.
- [ ] Preserve Playback Position when playback stops early.
- [ ] On natural completion, remove the Set, reset its position, start the next item, and stop on an empty queue.
- [ ] Do not sync a local database or introduce conflict resolution.

**You see.**

- [ ] A Set played on the simulator resumes at the same position in the macOS window.
- [ ] Play Next and Add to Queue produce the documented orders.
- [ ] A finished Set leaves the queue and the next item starts automatically.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for ordering, insertion after the active Set, append, Playlist replacement, rejection of a Set without Retained Audio, position bounds, completion, and the empty-queue stop. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for queue action semantics and the replacement confirmation. Run `bun run native:lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is one iOS simulator and one macOS window against one temporary server and one queue.

- [ ] Lane 1. Regression lane against trunk. Play a Set at trunk and at head. Trunk has no queue and no cross device position, so record that fact and gate the behaviour the user waits for, one queue and one resume point shared by both platforms. Save `queue-trunk-vs-head.png`. Pass when trunk has no queue state and head shares it.
- [ ] Lane 2. Vanta persists one ordered queue and active Set. Save `queue-persisted.png`. Pass when a read-only database query shows one queue with the active Set marked.
- [ ] Lane 3. Tapping a playable Set preserves the remaining queue. Save `queue-tap-preserves.png`. Pass when the tapped Set is active and every other entry keeps its relative order.
- [ ] Lane 4. Play Next inserts after the active Set. Save `queue-play-next.png`. Pass when the inserted Set is immediately after the active Set.
- [ ] Lane 5. Add to Queue appends. Save `queue-add-appends.png`. Pass when the added Set is last.
- [ ] Lane 6. Playing a Playlist replaces the queue in Playlist order. Save `queue-playlist-replaces.png`. Pass when the queue equals the playable Playlist members in Playlist order.
- [ ] Lane 7. Confirmation appears only when replacing an actively playing queue. Save `queue-replacement-confirmation.png`. Pass when it appears while playing and not while idle.
- [ ] Lane 8. A Set without Retained Audio cannot enter the queue. Save `queue-requires-audio.png`. Pass when the action is unavailable or refused with a clear message.
- [ ] Lane 9. Position synchronizes across platforms. Save `position-cross-platform.png`. Pass when a position written on the simulator reloads in the macOS window inside the update bound.
- [ ] Lane 10. Completion removes the Set, resets position, and starts the next. Save `queue-completion.png`. Pass when the finished Set is absent from the queue with a reset position, the next item is playing, and an empty queue stops.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Position writes per minute of playback, and the latency of a queue mutation visible on the other platform.
- [ ] Probe. Play the same ten minute Set at trunk and head while counting position writes, and run 20 queue mutations from the simulator and read them from the macOS window.
- [ ] Baseline. Record trunk's position write count first, which is zero because trunk has no Playback Position, and label the position metric as new work with an absolute budget.
- [ ] Rule. Fail when position writes exceed 12 per minute of playback, or when a queue mutation is not visible on the other platform within 2 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3, 4, 6, and 10 screenshots into `docs/plans/media/u10-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of queue actions, a Playlist replacing the queue, cross device resume, and automatic advance. Save it as `docs/plans/media/u10-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 14 is closed with the receipts.

## Record Listen and Finish statistics (U11)

**Depends on.** U10. Ticket 15.

**Files.**

- [ ] Create `apps/server/src/stats.ts` and `apps/server/src/stats.test.ts`.
- [ ] Edit `apps/server/src/library.ts` for the counter columns and their migration.
- [ ] Edit `apps/server/src/app.ts` for the Listen and Finish routes.
- [ ] Edit `apps/native/Orbis/SetDetail/` to show statistics.
- [ ] Edit `packages/contracts/src/index.ts` for the statistics contract.

**Build.**

- [ ] Count one Listen when a Set becomes active through intentional playback or automatic queue advancement.
- [ ] Never count another Listen for pausing and resuming the same active Set.
- [ ] Count at most one Finish per Listen, when playback reaches the natural end.
- [ ] Persist Listen count, Finish count, and last-listened date on Vanta.
- [ ] Show statistics in Set details and keep them out of Library rows.
- [ ] Make cross device retries and duplicate completion signals idempotent so counters never inflate.
- [ ] Do not add an event history, a telemetry pipeline, or a generalized analytics model.

**You see.**

- [ ] One Listen with one completion shows one Listen and one Finish.
- [ ] Pausing and resuming five times still shows one Listen.
- [ ] Sending the same completion signal twice still shows one Finish.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add HTTP boundary tests for manual activation, automatic advance, pause and resume, natural completion, replay creating a second Listen, duplicate completion signals, and cross device retries. Run `bun run --filter @orbis/server test`.
- [ ] Add native unit tests for the statistics display in Set details. Run `bun run native:lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open Set details at trunk and at head. Trunk has no statistics, so record that fact and gate the behaviour the user waits for, counts that appear in details and never in rows. Save `stats-trunk-vs-head.png`. Pass when trunk shows no counts, head shows them in details, and the Library rows are unchanged.
- [ ] Lane 2. Manual activation counts one Listen. Save `stats-manual-listen.png`. Pass when the counter increases by exactly one and the last-listened date updates.
- [ ] Lane 3. Automatic queue advance counts one Listen. Save `stats-auto-advance.png`. Pass when the advanced Set gains exactly one Listen.
- [ ] Lane 4. Pause and resume adds no Listen. Save `stats-pause-resume.png`. Pass when five pause and resume cycles leave the counter unchanged.
- [ ] Lane 5. Natural completion counts one Finish. Save `stats-finish.png`. Pass when the Finish count increases by exactly one.
- [ ] Lane 6. Replay creates a second Listen. Save `stats-replay.png`. Pass when the Listen count increases to two and the Finish count stays at one.
- [ ] Lane 7. Duplicate completion signals do not inflate. Save `stats-duplicate-signal.png`. Pass when repeating the same completion signal leaves the Finish count at one.
- [ ] Lane 8. Cross device retries do not inflate. Save `stats-cross-device.png`. Pass when a retried signal from the other platform leaves both counters unchanged.
- [ ] Lane 9. Statistics appear in details only. Save `stats-details-only.png`. Pass when Set details shows all three values and no Library row shows any.
- [ ] Lane 10. Counters survive a server restart. Save `stats-survive-restart.png`. Pass when values are identical after a restart.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Counter write count per Listen, per Finish, and per duplicate signal, plus the server time for one statistics update.
- [ ] Probe. Drive ten activation and completion cycles at trunk and at head, counting writes with read-only diagnostics and timing each update.
- [ ] Baseline. Record trunk first, which writes no counters, so treat the metric as new work with an absolute budget.
- [ ] Rule. Fail when a single Listen writes more than one counter row, when a duplicate signal writes any row, or when a statistics update exceeds 100 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 5, 6, 8, and 9 screenshots into `docs/plans/media/u11-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a Listen, a pause and resume cycle, a completion, a replay, and the details view. Save it as `docs/plans/media/u11-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 15 is closed with the receipts.

## Save Sets through Apple share extensions (U12)

**Depends on.** U3. Ticket 8.

**Files.**

- [ ] Create `apps/native/OrbisShare/` for the shared extension source, with `Info.plist` entries for iOS and macOS targets.
- [ ] Create `apps/native/OrbisShareTests/`.
- [ ] Edit `apps/native/project.yml` for the two extension targets and their embed phases.
- [ ] Edit `apps/native/Orbis/` to share the save contract with the extension rather than duplicating it.

**Build.**

- [ ] Implement iOS and macOS share extensions that accept supported Source Links.
- [ ] Implement the compact confirmation using available source metadata, with optional Tags, Playlist selection, and Download-after-saving controls.
- [ ] Route the save through the same canonical validation, duplicate handling, and enrichment contract as the app.
- [ ] Dismiss with clear feedback on success.
- [ ] When Vanta is unreachable, report the cause and preserve the Source Link on the clipboard.
- [ ] Keep one shared save contract, with no offline submission queue and no separate extension domain model.
- [ ] Do not add search, a management view, a menu bar item, or playback to the extension.

**You see.**

- [ ] Sharing a YouTube link from Safari into Orbis saves the Set and dismisses with confirmation.
- [ ] An unreachable Vanta reports the cause and leaves the link on the clipboard.
- [ ] The extension performs no save when the link is unsupported.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add extension tests for a valid link, a duplicate, an unsupported link, and an unreachable server, driven through the shared save contract with controlled inputs. Run `bun run native:lanes --share`.
- [ ] Add a shared contract test proving the app and the extension call the same validation and enrichment path. Run `bun run native:lanes --unit`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is iOS and macOS share sheets with a temporary server.

- [ ] Lane 1. Regression lane against trunk. Reach the save path at trunk and at head. Trunk has no share extension, so record that fact and gate the behaviour the user waits for, a share sheet that saves without opening the app. Save `share-trunk-vs-head.png`. Pass when trunk has no share target and head saves from the share sheet.
- [ ] Lane 2. The iOS extension appears for a supported link. Save `share-ios-present.png`. Pass when Orbis appears as a share target for a YouTube link.
- [ ] Lane 3. The macOS extension appears for a supported link. Save `share-macos-present.png`. Pass when Orbis appears in the macOS share menu.
- [ ] Lane 4. A successful save dismisses with feedback. Save `share-success.png`. Pass when the sheet dismisses and confirmation is visible.
- [ ] Lane 5. The confirmation exposes the optional controls. Save `share-optional-controls.png`. Pass when tag, Playlist, and Download-after-saving controls are present.
- [ ] Lane 6. A duplicate reports clearly and does not overwrite. Save `share-duplicate.png`. Pass when the stored Set is unchanged.
- [ ] Lane 7. An unsupported link is refused. Save `share-unsupported.png`. Pass when no save occurs and the message names the supported sources.
- [ ] Lane 8. An unreachable server reports the cause and preserves the clipboard. Save `share-unreachable.png`. Pass when the message names the cause and the clipboard contains the Source Link.
- [ ] Lane 9. No offline queue is introduced. Save `share-no-offline-queue.png`. Pass when a read-only database query after an unreachable attempt shows no queued submission.
- [ ] Lane 10. The extension and the app share one save contract. Save `share-shared-contract.png`. Pass when both paths produce identical stored rows for the same input.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Extension presentation time and save round trip time to visible confirmation.
- [ ] Probe. Present the share sheet and complete a save 20 times at trunk and head against a temporary server, interleaved.
- [ ] Baseline. Record trunk first, which has no extension, and treat the metric as new work with an absolute budget.
- [ ] Rule. Fail when extension presentation exceeds 1.5 seconds, or when a save round trip to visible confirmation exceeds 2.5 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 5, 6, and 8 screenshots into `docs/plans/media/u12-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of sharing a link on iOS and on macOS, including the failure path. Save it as `docs/plans/media/u12-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 8 is closed with the receipts.

## Save Sets through Raycast (U13)

**Depends on.** U3. Ticket 9.

**Files.**

- [ ] Create `apps/raycast/package.json` with the Raycast extension manifest and the two no-view commands.
- [ ] Create `apps/raycast/src/save-current-tab.ts`.
- [ ] Create `apps/raycast/src/save-clipboard.ts`.
- [ ] Create `apps/raycast/src/orbis-client.ts` for the shared call to Vanta, reusing the app's validation rules.
- [ ] Create `apps/raycast/src/__tests__/` for command-boundary tests.
- [ ] Edit `apps/raycast/README.md` with installation and the two command names.

**Build.**

- [ ] Implement Save Current Tab through the Raycast Browser Extension.
- [ ] Implement Save Clipboard through the Raycast Clipboard API.
- [ ] Validate YouTube and SoundCloud in the command before calling Vanta, reusing the same canonical rules as the server.
- [ ] Show animated progress and distinct success, duplicate, unsupported, and failure toasts.
- [ ] Require no running native app.
- [ ] Verify Helium compatibility. If the Browser Extension cannot inspect Helium, use the smallest documented macOS automation fallback and record the choice in the README.
- [ ] Add no search, management view, menu bar item, player, CLI, MCP, or agent feature.

**You see.**

- [ ] Save Current Tab saves the active browser tab and shows a success toast without opening Orbis.
- [ ] Save Clipboard reports a distinct duplicate toast for an already saved link.
- [ ] Neither command needs the native app running.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add command-boundary tests asserting the submitted Source Link and the observable toast for valid, duplicate, unsupported, and failure cases with controlled Browser Extension, clipboard, and HTTP responses. Run `bun run --filter @orbis/raycast test`.
- [ ] Add a test proving the command's validation matches the canonical rules, reusing the server's own cases. Run `bun run --filter @orbis/server test` for the shared cases.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The surface is a real Raycast window with a temporary server.

- [ ] Lane 1. Regression lane against trunk. Save a link at trunk and at head. Trunk has no Raycast commands, so record that fact and gate the behaviour the user waits for, capture without opening the app. Save `raycast-trunk-vs-head.png`. Pass when trunk has no command and head saves.
- [ ] Lane 2. Save Current Tab reads the active browser tab. Save `raycast-current-tab.png`. Pass when the submitted Source Link matches the active tab exactly.
- [ ] Lane 3. Save Clipboard extracts a supported link. Save `raycast-clipboard.png`. Pass when a link embedded in surrounding text is extracted and submitted.
- [ ] Lane 4. An unsupported link produces a distinct toast. Save `raycast-unsupported-toast.png`. Pass when no request reaches Vanta and the toast names the supported sources.
- [ ] Lane 5. A duplicate produces a distinct toast. Save `raycast-duplicate-toast.png`. Pass when the toast differs from success and the stored Set is unchanged.
- [ ] Lane 6. Success produces animated progress then a success toast. Save `raycast-success-toast.png`. Pass when progress is visible before the success toast.
- [ ] Lane 7. A failure produces a distinct toast with the cause. Save `raycast-failure-toast.png`. Pass when stopping the server produces a failure toast naming the cause.
- [ ] Lane 8. The native app is not required. Save `raycast-no-app-needed.png`. Pass when the command works with the native app closed.
- [ ] Lane 9. Helium compatibility is verified or a fallback is recorded. Save `raycast-helium.png`. Pass when Helium is inspected successfully or the README records the fallback and its own evidence.
- [ ] Lane 10. The extension stays capture only. Save `raycast-capture-only.png`. Pass when Raycast shows exactly two commands and no search, management, menu bar, or player feature.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from command invocation to visible toast, and the request time to Vanta.
- [ ] Probe. Invoke each command 20 times at trunk and head against a temporary server, interleaved.
- [ ] Baseline. Record trunk first, which has no command, and treat the metric as new work with an absolute budget.
- [ ] Rule. Fail when invocation to visible toast exceeds 2 seconds, or when the request to Vanta exceeds 500 ms locally.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3, 5, 6, and 7 screenshots into `docs/plans/media/u13-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of both commands, including the duplicate and failure paths. Save it as `docs/plans/media/u13-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] `bun run check` exits zero, with the Raycast package included in the workspace and its tests wired in.
- [ ] Rebased onto current `main`, patch-id unchanged.
- [ ] The operator fast-forwards, and ticket 9 is closed with the receipts.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Every ticket from 2 to 15 is closed with a resolution comment linking its SHA, its receipts, and the plan box that verified it.
- [ ] Ticket 3 is updated to record that its sub-issues are complete, and is closed when its own acceptance criteria are satisfied.
- [ ] `bun run check` exits zero at the final `main` SHA, and CI is green on `main`.
- [ ] Reply to the operator with the unit table of id, ticket, head SHA, verdict, and landed or blocked.

## Appendix A. Prototype evidence

Two throwaway prototypes settled the two questions that would otherwise have been guessed.

**Native toolchain, scratch path `/tmp/orbis-native-spike`, commit `cfad20db3ea1feeeacdfed2a554ebf72acc03491`.** It answers whether this machine can generate, build, run, and screenshot one SwiftUI multiplatform app from the command line.

- An xcodegen specification with one target carrying `supportedDestinations: [iOS, macOS]` produces a real multiplatform scheme with both an iOS Simulator destination and a macOS destination. Version 2.45.4 was used.
- iOS Simulator unit tests and UI tests run from the command line with exit code 0. The UI test drove a real journey, found rows, tapped the search field, typed, and asserted that a filtered row disappeared.
- The macOS app builds and its unit tests run, but only after adding a platform-conditional test host. xcodegen writes `TEST_HOST = "$(BUILT_PRODUCTS_DIR)/OrbisSpike.app/OrbisSpike"`, which is the iOS layout. The macOS bundle puts the binary under `Contents/MacOS/`. The fix is `TEST_HOST[sdk=macosx*]` and `BUNDLE_LOADER[sdk=macosx*]` style conditional settings, which xcodegen passes through and Xcode honours.
- Screenshots work two ways. An XCUITest `XCTAttachment` is exported with `xcrun xcresulttool export attachments`, which preserves the attachment name. `xcrun simctl io <device> screenshot` also works and needs no extra permission.
- A dedicated simulator, created with `xcrun simctl create`, renders the app without system dialogs. An existing simulator with a signed-in Apple ID overlays an Apple Account password dialog on the app and pollutes screenshots.
- Element queries have two traps. `XCUIElement.click()` is invalid on iOS and fails with "Pointer events are not supported for this device", so use `tap()`. An accessibility identifier on a SwiftUI `List` does not appear in the tree at all, so query rows through `app.cells` or the row's `StaticText` instead.
- The macOS UI test runner is killed before bootstrap with "Test crashed with signal kill before establishing connection", and `screencapture` fails with "could not create image from display". The Accessibility API still works, because `osascript` returned the app's window title and its named elements. This is why macOS lanes use an Accessibility driver and text evidence until the operator grants Screen Recording.

**Retained audio format and range behaviour, scratch path `/tmp/orbis-media-spike`, commit `1e539e486b1655a012eccec183d0fa3946a22a87`.** It answers which Cobalt output AVFoundation can actually play, and what the media endpoint must support.

| Candidate | Container | Codec reported | AVFoundation | Seek |
| --- | --- | --- | --- | --- |
| AAC | m4a | `aac` | plays | 60 s to 63.10 s |
| MP3 | mp3 | `.mp3` | plays | 60 s to 63.08 s |
| Opus | ogg | `opus` | plays | 60 s to 63.08 s |
| Opus | webm | none | Cannot Open, AVFoundation error -11828 | not reached |
| PCM | wav | `lpcm` | plays | 60 s to 63.09 s |

- WebM Opus is rejected outright, so a WebM container must never be the retained format even though Ogg Opus plays.
- AVFoundation issued 16 requests and every one carried a `Range` header. None was a plain full-body request. The pattern includes `bytes=0-1`, a tail read at the end of the file, and a mid-file read after a seek. Byte range support is mandatory, not an optimisation.
- Opus and PCM report `estimatedDataRate` of 0 through AVFoundation, so duration and size must come from the file or from Cobalt, never from that property.
- A Bun server answering `206` with `content-range`, `content-length`, and `accept-ranges` satisfied every request and every seek.

Two questions stay unproven. Nothing here proves playback of Opus or a multi-hour file on real iOS hardware, and the prototype used a Mac local loopback rather than the Tailscale path, so no range behaviour over Tailscale is measured yet. U6 and U9 close both.

## Appendix B. Alternatives rejected

- Shaping the plan around pull requests. The repository has no pull request surface, its issue tracker document states that pull requests are not a request surface, and its history is direct commits to `main`. The unit sections therefore describe a reviewed commit series that lands by fast-forward, while keeping the plan's evidence structure intact.
- Using `xcodebuild test` for macOS verification. Rejected because the runner is killed before bootstrap on this machine. The Accessibility driver replaces it, and the Screen Recording grant is the smaller fix if the operator prefers screenshots.
- Sharing one simulator across lanes. Rejected after a signed-in Apple ID overlaid a system dialog on the app. Each lane workstream gets the dedicated `Orbis Lanes` simulator.
- Putting the native app in `apps/ios`. Rejected because U2 ships one multiplatform app for iOS and macOS. The directory becomes `apps/native` and the reserved `apps/ios` README is removed.
- Targeting iOS 27 and macOS 27. Rejected because this machine has Xcode 26.6 with the iOS 26.5 SDK. The operator chose iOS 26 and macOS 26, and the deployment target rises when Xcode 27 is available.
- Choosing MP3 as the default only because it is safest. Deferred rather than rejected. Ogg Opus plays and seeks correctly in the prototype and is smaller, so U6 measures both against the real Cobalt deployment before deciding.
- Adding a migration library for the new columns. Rejected in favour of a hand-written migration in `apps/server/src/library.ts`, because the schema is small and the existing code already creates its own tables.

## Appendix C. Risks

- The Tailscale trust boundary is the largest unproven design. The current server rejects a non-loopback Host and a browser Origin, and Tailscale Serve proxies from loopback with a tailnet host name, so the existing check will reject the native clients. U2 must settle whether trust comes from the proxy address, a shared secret header, or a Tailscale identity header, and must keep rejecting direct untrusted access. The `architect` gate exists for this reason.
- macOS lane evidence is text rather than screenshots until the operator grants Screen Recording. If the grant is refused, the macOS surface is verified by Accessibility tree and unit tests only, and that gap must be stated in each macOS lane's report.
- The plan's dependency order follows the issue graph exactly. Ticket 10 lists ticket 4 as a blocker, but the format decision only needs the Cobalt host from ticket 2 plus Apple platform playback, which the simulator reaches without the full ticket 4 UI. The operator may pull U6 earlier if schedule pressure appears.
- Multi-hour and iOS-device playback stay unproven until U6 and U9. The prototype used a 90 second local fixture.
- Long transfers on Vanta compete with twelve unrelated containers. U1 measures the host before and after, and U7 keeps the transfer bounded, but a sustained download may still affect neighbouring services.
- This repository has had at least two concurrent agent writers, and one commit landed two minutes into the session that produced this plan. Every unit therefore works in its own `git worktree`, and every verification records the exact SHA. A unit whose head SHA is superseded by a rebase needs a fresh verdict.
- `main` is red before the program starts. The `format:check` failure on `AGENTS.md` and `docs/research/cobalt-self-hosting.md` is reproduced at `origin/main`, and CI is failing on the same task with eight of nine tasks succeeding. Arm the program with that fix, and do not let a unit inherit a red baseline.

## Appendix D. Links and reading list

- `docs/agents/domain.md` and `CONTEXT.md` hold the glossary. Retained Audio, Download, Listen, Finish, Playback Position, and Listening Queue all have fixed meanings that the code must match.
- `docs/agents/issue-tracker.md` governs how tickets are read, claimed, and closed. Claim with `gh issue edit <number> --add-assignee @me` before starting a unit.
- `docs/agents/triage-labels.md` governs labels. All twelve tickets already carry `ready-for-agent`.
- `docs/adr/0001-client-platform-strategy.md` records why native Apple clients come before a web client.
- `docs/adr/0002-persist-download-jobs.md` is the decision U7 implements.
- `docs/ops/cobalt-trial.md` is the operator runbook for U1 and the source of the trial's bounds.
- `docs/research/cobalt-self-hosting.md` records the upstream research behind the trial.
- `README.md` must be updated by U2 with the native app, its build commands, and the removal of the `apps/ios` reservation.
- Run `how` before U2's identity work and before U9's player work, because both change an unfamiliar subsystem.
- Run `interrogate` on U6's format decision and on U2's identity decision before either is accepted.
- Keep the decision trail per `~/.pi/agent/npm/node_modules/@zenspc/pi-pstack/skills/show-me-your-work/SKILL.md`. Commit it for U1, U6, and U7, where the evidence is remote, measured, or irreversible.
