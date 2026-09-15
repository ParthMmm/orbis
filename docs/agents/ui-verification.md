# Verifying the Orbis UI with agent-device

`bun run native-lanes` owns automated verification for the Apple client. This note covers the complementary pass an agent makes by hand: driving a real build on a real simulator, and the traps that cost time or, worse, produce a wrong conclusion.

Recorded 2026-09-14 from a full iPhone pass on iOS 26.5 against `a8af6cc`. Tool version `agent-device 0.20.10`.

## A screenshot is evidence only if the environment is clean

The most expensive thing that happened in that pass was a false product bug. After filing a link, the Set never appeared in the Library, and the Library still said **Start your collection**. The service held the Set, and two `GET /sets` calls had returned `200` with it. That reads as a real defect.

It was not. An iCloud **Apple Account Verification** alert was up and swallowing taps. Once the alert was dismissed, the Set was there after a plain refresh.

An iOS simulator raises these unprompted: **Apple Account Verification**, and **Save Password?** after any form with a `SecureField` is submitted. `agent-device alert dismiss` clears the first. The second is a sheet rather than an alert, so it needs a snapshot and a press on **Not Now** — and `find "Not Now"` matches three elements, so take the ref from `snapshot -i` instead.

Two habits follow, and both are cheap:

- Before reporting that a control did nothing, dismiss any system UI and retry. A settled tap that changes nothing is a product finding only after the environment is known clean.
- Read the screenshot, not just the accessibility tree, before believing a state. `15-library-one-set.png` in the 2026-09-14 pass was discarded because the capture silently included the iCloud alert over the app's own UI.

## Pin the platform and the session

Orbis ships as a macOS app and a simulator app under one bundle id, `app.orbis.client`. A bare `agent-device open app.orbis.client` in this repository attached to the **installed macOS app** at `~/Applications/Orbis.app`, and reported only `Opened: app.orbis.client`. The mistake is invisible until something looks wrong, and `appstate` printed nothing at all for that session.

Always name both:

```sh
agent-device open app.orbis.client --platform ios --device "iPhone 17 Pro" --session orbis-ios --foreground
```

Confirm the target with `agent-device session` or `agent-device device status` before trusting a snapshot. The session is keyed to the working directory, so leaving the default session unnamed means the next agent inherits whatever the last one left.

## Refs do not survive a mutation

Every settled interaction emits a fresh frame whose refs carry a pin (`@e14~s199512`). A plain ref from an earlier snapshot is rejected, with one of two messages depending on age:

- `Ref @e56 needs a complete snapshot — the current frame only authorizes its emitted refs`
- `Ref @e4 belongs to an expired ref frame — a device action since the snapshot invalidated it`

So read refs from the settled diff, not from a snapshot taken before the interaction, and never carry a ref across one. When a diff is not enough, `snapshot -i` costs a call and removes the class of error.

## Prefer refs over `find`, and know why

`find` matches loosely, and the obvious words collide on these screens: `Library` (tab and heading), `Refresh` (menu cell and its label), `Not Now` (sheet cell and button) each returned `AMBIGUOUS_MATCH`. The error prints a `Candidates:` heading with an empty list, so it names the problem without resolving it. `snapshot -i` plus an exact ref is faster than guessing.

`find` also accepts no `--settle`, so `find <text> press` returns without a settled diff. That is fine for a confident single step and wrong for anything whose result is the point of the check.

## Three commands that carry their weight

- `screenshot --pixel-density 3 --normalize-status-bar` gives clean 3x design artifacts with deterministic chrome. This is the right shape for reviewing spacing and hierarchy.
- `screenshot --overlay-refs` draws each ref's rectangle onto the capture. It is what turned "maybe I tapped the wrong place" into a defect: the overlay showed the tap landing exactly on the drawn `techno` pill while the filter never engaged.
- `get attrs @ref` returns `rect` (`x`, `y`, `width`, `height`), `hittable`, `enabled`, `type`, and `identifier`. It also accepts a selector. This is the one that settles a layout claim.

## Measure, do not read

A screenshot suggests. `get attrs` decides. Every layout claim in the 2026-09-14 pass came out of a screenshot first, and three of them had to be withdrawn once the geometry was read, so take the measurement before writing the finding:

- **Does it fit?** Compare the transport's time label against the window: `x 298 + width 104 = 402`, the window width. It touches the edge with zero inset and never overflows. In the screenshot it looked as though it ran off the edge.
- **Is it occluded?** Compare bands. The transport's bottom edge is `y = 791` and the tab bar's top edge is `y = 791`: they abut, they do not cross. `hittable: true` on the controls settles it.
- **Is the target big enough?** `height: 20.33` on the play control answers that in one number.

The window is a ref too: `get attrs @e1` gives the application frame to measure everything against.

`is <predicate> <selector>` takes a selector rather than a ref, and is the right shape for a pass or fail assertion. `get` accepts either a ref or a selector.

## A scroll position is not a layout

Two withdrawn claims came from captures of a scrollable list part-way down, where the last row and the footer sat under the floating bar. That is simply what scrolling under a floating bar looks like. At the end of the scroll both are clear — last row `y 645–745`, footer `y 760–775`, bar at `y 791` — in the filtered and unfiltered lists alike. Scroll to the edge before judging occlusion, and state which scroll position a claim applies to.

## A delta is not an assertion

A non-empty settled diff means something changed, not that the thing you wanted changed. Pressing the dead tag pill reported `+3 -4`, and every changed node was incidental tree normalisation: a `"0 pages"` placeholder leaving as the tree settled. The heading was still `Everything`.

Assert the expected state by name — the heading text, the predicate, the frame — and treat a diff as a hint about where to look. Two presses reporting `+0 -0` beside an unchanged heading is the finding; `+3 -4` on the first press would have been read as success.

## Make the negative controlled

"This control does nothing" is only persuasive beside something on the same screen that works. In one pass, on one build at one scroll position: pressing a row opened the Set page, while pressing the filter pill twice left the heading at `Everything`. Keep a known-responsive control in the same pass, and record the commit and the binary digest the pass ran against.

## Pairing a simulator to the real service

The simulator shares the Mac's network stack, so a Tailscale address resolves and connects with no extra setup: MagicDNS resolved `vanta.tail01d084.ts.net` and `Test connection` succeeded on the first try. `~/.orbis/config.json` holds the pair this Mac already uses, but the iOS app cannot read it — that fallback is compiled for macOS only — so the address and token are typed on the connection screen like any first launch.

Read the address and token from that file rather than printing them:

```sh
agent-device fill @e8 "https://vanta.tail01d084.ts.net:8444" --session orbis-ios --settle
agent-device fill @e53 "$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.orbis/config.json')))['deviceToken'])")" --session orbis-ios --settle
```

Do not start a local server against the development database to read a real library. `apps/server/data/library.sqlite` is empty; the library on Vanta is the one with Sets in it. For states that need writes — filing, renaming, removing — start a throwaway service instead, with its own data directory and its own enrolment, so the real library is never touched:

```sh
ORBIS_DATA_DIR=/tmp/orbis-scratch ORBIS_PORT=4310 bun apps/server/src/index.ts
bun apps/server/src/trust.ts add --label scratch --devices /tmp/orbis-scratch/devices.json
```

Repair the pairing afterwards, then confirm the real Sets are back before ending the session.

## Where the journey suite stops

`bun run native-lanes` verifies text, identifiers, and navigation, and it does that well. It does not currently assert geometry, and it does not tap the controls the Library filters with. The tag filter is reached only through `-orbisStartTagFiltered`, so the pill itself is never exercised — and the 2026-09-14 pass found that pill accepting no tap at all, plus a transport that ignores the page's margins and a 20.33pt play target. None of it is visible to a suite that asserts labels it already believes.

Three additions would close the gap without a new tool:

- Tap the filter pill on the Library and assert the heading changes, rather than launching pre-filtered.
- Assert one inset invariant: with a Set playing, the transport's controls are `hittable`, keep the page's horizontal margin, and clear the tab bar's top edge. `get attrs` supplies all three.
- Assert the empty-Library and the hides-everything states are distinguishable, since one currently wears the other's copy.

## A stale read is not a measurement

`press` on a stale ref fails loudly. `get text` on a stale ref does not: it returns the value from the frame that ref belonged to. Two `get text` readings of the playback clock six seconds apart both returned `0:09 / 1:15:25` while playback was in fact advancing at about one second per second. That is indistinguishable from a stalled stream, and it very nearly became a filed bug.

Take readings from fresh `snapshot -i` calls, never from a ref held across other reads. The doubled cost is the price of the measurement meaning anything.

## Test both directions of a toggle

A control that turns something off but not on fails in a way that only looks like death. The tag filter pill was pressed five times across two sessions from an unfiltered Library and did nothing; issue #41 was filed as "the pill accepts no tap at all". Pressing it once from a _filtered_ Library cleared the filter immediately. The control worked the whole time, in one direction.

So drive a toggle to each state and back, and prefer reaching a state by a second route (a launch argument, a service-side change) before concluding the control that sets it is broken. `--overlay-refs` proved the taps landed on the pill, which was consistent with both explanations and did not distinguish them.

## A receipt from the 2026-09-14 re-verification

Every finding in the pass was re-checked against a clean `a8af6cc` build on the same simulator, with the app binary at `840613a46643d5bdc92da63f339b51a3e65638fbc498e715abd2febb9178135d`. Recording the commit and the digest is what makes the result reproducible after a rebase.

| Claim | Outcome |
| --- | --- |
| The tag filter pill accepts no tap | Reproduced. Two presses, heading stayed `Everything`, `+0 -0` |
| A row opens the Set page | Reproduced. The control for the negative |
| The transport is occluded and unusable | **Withdrawn.** `hittable: true`; slider bottom `791` abuts bar top `791` |
| `Pause` is cut by the left edge | **Withdrawn.** Drawn complete at `x = 0`; inset-free, not clipped |
| The time label overflows the right edge | **Withdrawn.** Right edge exactly `402` = window width, at both durations |
| The last row and footer render under the bar | **Withdrawn.** At end of scroll, `y 645–745` and `y 760–775`, bar at `791`, filtered and unfiltered |
| The transport ignores the page margins | **Added** by measurement: `x = 0`, right edge `402`, zero gap to the bar, `20.33pt` play target |
| The first row loses its label | Reproduced, and broader than recorded: unfiltered too |

Four of nine findings survived contact with the geometry unchanged. The four that did not had all been written from screenshots, which is the reason this section exists.

### The maintenance pass, same day

The feature map in `.agents/skills/verify-orbis/` was checked in two waves against the same `a8af6cc` client: one read-only recon per feature file, then a live pass driven serially on one instance.

| Claim | Outcome |
| --- | --- |
| The tag pill accepts no tap | **Corrected.** It turns the filter off but never on |
| Progress advances while playing | Verified: `43.5 → 48 → 52.5`, and only after a stale `get text` reading was caught |
| Pause holds the position | Verified: label flipped to `Play`, value held across three reads |
| Drag seeks | Verified: the time jumped to `1:14:10` |
| Tap seeks | **Refuted.** Pressing the track's midpoint while paused changed nothing |
| `Clear search` clears the query | **Refuted.** The query stays and the area shows `Loading` indefinitely |
| A search result opens its Set | **Refuted.** `+0 -0`, the app stays on Search |
| The untagged-Set filter case renders as empty | Confirmed again |

Not covered in that pass: `file.md` and the mutating half of `set-page.md`, which need the scratch service. They are recorded as unverified rather than passed.
