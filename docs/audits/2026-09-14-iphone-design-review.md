# iPhone design review — 2026-09-14

Screenshots of every iPhone screen, taken on a booted iOS 26.5 iPhone 17 Pro simulator (`DEA43456-6EAA-4628-BC02-340C354B1D28`) with `agent-device`, at 3x with a normalized status bar. The app was paired to the real service on Vanta over the tailnet, so the Library screens show the real eight Sets. States that need an empty library or a fresh filing were captured against a throwaway loopback service, so nothing was written to the real library.

Build: `xcodebuild -scheme Orbis` at 16:16, from `a8af6cc` plus the working-tree changes present at that time. Two files changed under the tree after this build (`project.yml`, `TagInput.swift`); the tag-remove hit target and the Info.plist keys are not visible in these screens.

## Screens

The captures below are local artifacts under `docs/audits/screens-2026-09-14/` and are not committed, matching how the other audit passes in this directory are recorded. Every finding stands on the measurements, identifiers, and service responses quoted in it rather than on the images.

| File                             | Screen                            |
| -------------------------------- | --------------------------------- |
| `01-connect.png`                 | First launch, unpaired            |
| `02-library.png`                 | Library, loaded, eight Sets       |
| `03-library-actions.png`         | Library actions menu              |
| `04-set-detail.png`              | Set page                          |
| `05-search-empty.png`            | Search, untouched                 |
| `06-search-results.png`          | Search results                    |
| `07-search-no-results.png`       | Search, no match                  |
| `08-connection-settings.png`     | Connection settings while paired  |
| `09-connection-error.png`        | Connection failure                |
| `10-library-filtered.png`        | Library filtered by tag           |
| `11-set-detail-playing.png`      | Set page, playing                 |
| `12-library-empty.png`           | Library with no Sets              |
| `12-filter-hides-everything.png` | A tag filter that hides every Set |
| `13-naming-step.png`             | "Name this set" after filing      |
| `14-filed.png`                   | Filed confirmation                |

## Findings

Ordered by how much they get in the way. Line references are to the tree at the time of the build.

### 1. The Set page's transport ignores the page margins

**Corrected on re-measurement. The original finding claimed occlusion by the tab bar and was wrong.**

The transport row is the only full-bleed element on the page. Measured on iOS 26.5, iPhone 17 Pro (402 × 874 pt), the play/pause control's left edge is at `x = 0` and its height is `20.33pt`; the elapsed and total label right-aligns to exactly `x = 402`, the window edge, and grows leftward, so it fits at both durations measured (`0:51 / 36:24`, `0:09 / 1:15:25`). Every other element keeps a 16pt margin: the Set card, the rows (`x = 16`, `width = 370`), and the Library footer (`x = 16`). The transport's bottom edge is `y = 791`, exactly the tab bar's top edge, so they abut with no gap; the Library footer keeps 16pt in the same place.

So the transport is inset-free and gap-free rather than occluded, and its play target is under half the 44pt minimum. It reads as clipped in a screenshot because a full-bleed row next to a floating bar looks broken, which is what the original claim mistook for occlusion.

What the original claim got wrong, and why: `02-library.png` and `10-library-filtered.png` were mid-scroll frames, and a scroll position is not a layout. Once scrolled to the end, the last row sits at `y 645–745` and the footer at `y 760–775` in both the filtered and unfiltered lists, clear of the bar at `791`. Both controls also report `hittable: true`. See the issue for the full measurement set.

The player has no home outside the scrolling page, which is why nothing constrains it to the page's own margins.

### 2. A tag filter that hides everything reads as an empty library

`12-filter-hides-everything.png`. One untagged Set, filtered by `techno`: the screen says **Start your collection — Paste a link to file your first set.** with no heading, no filter pill, and no way to clear the filter. The user is told their library is empty about a library that is not empty, and the only escape is to relaunch.

`SetList.emptyPresentation` (`Orbis/LibraryView.swift:56`) renders the hero and the empty view and drops the heading and the filter row. Both callers pass the same empty view for "no Sets" and "no Sets match this filter", so the two states cannot be told apart on screen.

`14-filed.png` is the same trap with a fresh filing on top: **Filed "YouTube video"** sits directly above **Start your collection**, so the screen denies the filing it just confirmed.

### 3. The tag filter pill turns the filter off but not on

**Corrected on re-measurement. The original finding claimed the pill accepted no tap at all.**

From a filtered Library the pill works: pressing it clears the filter, the heading returns to `Everything`, and all nine Sets come back. From an unfiltered Library it does nothing — five presses across two sessions, each reporting a settled tap and `+0 -0` with the heading unchanged, re-verified as four consecutive presses in a single run.

So the Library cannot be filtered by tag from the UI, and the filtered state is reachable only through the `-orbisStartTagFiltered` launch argument, which is how the journey test reaches it. No test taps the pill. `TagPill` (`OrbisDesign/.../TagChip.swift`) is a `Toggle` with `.toggleStyle(.button)` and `.buttonStyle(.bordered)`; that the off direction works proves taps reach the control, so the fault is in the binding rather than hit testing.

The original error was methodological: the pill was only ever pressed from the unfiltered state, where a one-directional failure is indistinguishable from a dead control. `screenshot --overlay-refs` had confirmed the tap landed on the drawn pill, which was consistent with both readings and did not separate them. Testing the other direction took one relaunch.

Also found by source recon and confirmed live: no row chip carries the `active filter` label in a filtered Library, because `SetList`'s `activeTag` is never passed to `SetRow`.

### 4. Search reports failure before a query is typed

`05-search-empty.png`. Opening the Search tab shows the icon, **No matching sets**, and an orange **Clear search** button, before anything is typed or submitted. `SearchDestination.displayedState` (`Orbis/RootView.swift`) returns `.loaded([])` for an empty query, so the no-results state renders.

### 5. The paste hero and the empty state both ask for a link

`12-library-empty.png` stacks two full paste affordances: the hero (**Drop a link, file a set.** with a field, **File it**, a separate **Paste** button, and the hint **Title and tags come next.**) and then **Start your collection → Paste a link**. Two calls to action for one job, four controls.

### 6. The Set page says the title three times and buries its ordering

`04-set-detail.png`. The navigation title truncates (`KETTAMA @ Creamfie…`), the page title repeats it in full, and the **Title** row shows it a third time. Below that, **Remove from library** sits between the card and its own explanation, above the player, so the one destructive control on the page is the most prominent thing in the middle of it.

### 7. The naming step keeps the empty state and buries its error

`13-naming-step.png`. The reveal panel appears over a Library that still offers **Start your collection → Paste a link**, inviting a second filing while the first is unnamed. Inside the panel the metadata failure line **Orbis could not name this set. Try again** sits under the Done/Not now pair, so it reads as part of the button group.

### 8. The paired connection screen keeps its first-launch framing

`08-connection-settings.png`. The screen still says **Connect to Orbis** and offers no back control; the only way out is **Keep the library I have**, which is a phrase about a library rather than about leaving the screen. `ConnectionView` takes `cancellable` but does not change its title for it.

### 9. Accessibility: the first row of the Library loses its label

In the tree for `10-library-filtered.png`, the first row exposes `set-row-<uuid>` where every other row exposes its index, source, date, title, and tags. VoiceOver reads an identifier instead of the Set.

Confirmed on a clean `a8af6cc` build, and broader than first recorded: it also happens in the unfiltered Library, so the trigger is being the first row rather than being filtered. The row's real content appears as a separate node while the button carries the identifier.

## Found by the later verification pass

Two functional defects outside this pass's design scope, both confirmed live and filed:

- **A search result cannot be opened.** Tapping a result row leaves the app on Search. `SearchDestination` passes no `select` to `SetList`, so its rows are never wrapped in a Button. Search finds a Set that cannot then be opened, renamed, or removed. Filed as #42.
- **`Clear search` leaves the query and stalls.** Pressing it keeps the query in the field and parks the result area on `Loading` indefinitely; `clearSearch()` never resets `searchQuery`. Filed as #43.

And one correction to this pass's own finding 3: the tag filter pill is not inert. It turns the filter **off** but never **on**. See the revised finding above and #41.
