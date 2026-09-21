import OrbisDesign
import SwiftUI

/// One list for both destinations, so loading, failure, and the empty cases are defined once
/// and wear the same design. The states themselves come from OrbisDesign; this view decides
/// where they sit and what they are called.
struct SetList: View {
  let state: Loadable<[SavedSet]>
  /// The heading over the list, absent on a screen whose title already names it.
  let heading: Text?
  /// The state a loaded-but-empty list shows, composed by the caller from OrbisDesign and
  /// carrying its own accessibility identifier.
  let empty: AnyView
  /// What the app was doing when a failure happened, in the words the screen would use.
  var failureContext = "loading the library"
  /// The tag the list is filtered by, so the row marks it as the active one.
  let activeTag: String?
  /// Filter controls shown beside the heading, absent on a screen that only reads.
  let filters: AnyView?
  /// The state a filter shows when it admits nothing. A screen that can narrow its list
  /// supplies it, so a collection that is empty and a collection the person has filtered
  /// down to nothing never wear each other's copy.
  let noMatches: AnyView?
  /// A screen that files Sets puts its paste field here, so it scrolls with the rows and is
  /// absent on a screen that only reads, such as Search.
  let hero: AnyView?
  /// A screen with a collection can put its horizontal rails — the recently filed, the
  /// playlists — between the hero and the list header, the way a music app's home carries its
  /// sections. Absent on a screen that only reads.
  var rails: AnyView?
  let footer: String
  let retry: () async -> Void
  /// What a journey or a manual pass reads this list by, so the two destinations do not
  /// answer to the same name.
  var listIdentifier = "library-list"
  /// A screen that opens a Set puts its action here, so a row knows it can be pressed and a
  /// screen that only reads does not pretend otherwise.
  var select: ((SavedSet) -> Void)?
  /// The Set in the player and whether it is playing, so its row is marked and its control
  /// says the change it makes. Plain values, not the player, so the list redraws on a change
  /// of Set or of state and never on the clock.
  var currentSetId: String?
  var isPlaying = false
  /// Starts, pauses, or resumes a Set from its row. Absent on a screen that only reads.
  var togglePlayback: ((SavedSet) -> Void)?

  @Environment(\.openURL) private var openURL

  var body: some View {
    Group {
      switch state {
      case .idle, .loading:
        LoadingState()
          .accessibilityIdentifier("library-loading")
      case .failed(let failure):
        UnavailableState(failure: failure, context: failureContext) {
          Task { await retry() }
        }
        .accessibilityIdentifier("library-error")
      case .loaded(let sets):
        if sets.isEmpty {
          emptyPresentation
        } else {
          rows(sets)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.orbis.paper)
  }

  /// An empty Library and a filter that admits nothing are different states, and they were once
  /// indistinguishable on screen. Both keep the paste field, so filing the first Set never means
  /// hunting for a control that disappeared when the list emptied. A screen that can filter
  /// supplies its own no-matches view, and gets the heading and the filter row back, so a filter
  /// is cleared where it was set rather than by relaunching.
  ///
  /// Neither state scrolls, which is how Search already showed the same component: the field
  /// above it and the state itself both fit a phone, and a state that sizes itself to the space
  /// it is offered has no reason to be handed unbounded height.
  private var emptyPresentation: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let hero {
        hero.padding(.bottom, 16)
      }
      if let noMatches {
        listHeader
        noMatches.frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        empty.frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .padding()
  }

  private func open(_ set: SavedSet) {
    guard let link = SetPresentation.sourceURL(set) else { return }
    openURL(link)
  }

  /// The heading, the rule under it, and the line that carries the count and the filters. The
  /// rows and the no-matches state share it, because both are answers about the same list.
  private var listHeader: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let heading {
        heading
          .font(.orbis.sectionTitle)
          .padding(.bottom, 12)
      }
      ListingRule()
      HStack(alignment: .firstTextBaseline) {
        ListingLabel(footer)
        Spacer()
        if let filters {
          filters
        }
      }
      .padding(.vertical, 12)
      .overlay(alignment: .bottom) { Divider() }
    }
  }

  private func rows(_ sets: [SavedSet]) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let hero {
          hero.padding(.bottom, 16)
        }
        if let rails {
          rails.padding(.bottom, 20)
        }
        listHeader
        // The list can hold a whole library, so rows are built as they scroll into view
        // rather than all at once. Sets group under the day they were filed, so the date is
        // structure rather than a value on every row.
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Self.days(of: sets), id: \.day) { group in
            ListingHeader(group.day)
            ForEach(Array(group.sets.enumerated()), id: \.element.id) { index, set in
              if index > 0 {
                Divider()
              }
              row(set)
            }
          }
        }
      }
      .padding()
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier(listIdentifier)
  }

  /// One Set. The row owns both of its targets: the artwork plays and the rest opens. The
  /// long-press menu repeats both, and adds the Source Link, for anyone who reaches for it.
  private func row(_ set: SavedSet) -> some View {
    let model = SetPresentation.row(set, activeTag: activeTag)
    let playback = SetPresentation.playback(
      of: set, currentSetId: currentSetId, isPlaying: isPlaying)
    return SetRow(
      title: model.title,
      source: model.source,
      artwork: model.artwork,
      creator: model.creator,
      length: model.length,
      tags: model.tags,
      activeTag: activeTag,
      state: model.state,
      progress: model.progress,
      playback: playback,
      togglePlayback: togglePlayback.map { toggle in { toggle(set) } },
      select: select.map { select in { select(set) } }
    )
    .accessibilityIdentifier("set-row-\(set.id)")
    .contextMenu {
      if let playback, let togglePlayback {
        Button(playback.label, systemImage: playback.symbol) { togglePlayback(set) }
      }
      // "Open" is the Source Link's word on this page, so the page itself is "Details".
      if let select {
        Button("Details", systemImage: "info.circle") { select(set) }
      }
      Button("Open Source", systemImage: "safari") { open(set) }
    }
  }

  /// The Sets in the order given, grouped under the day each was filed.
  struct DayGroup {
    let day: String
    let sets: [SavedSet]
  }

  static func days(of sets: [SavedSet]) -> [DayGroup] {
    var groups: [DayGroup] = []
    for set in sets {
      let day = SetPresentation.day(set.createdAt)
      if groups.last?.day == day {
        groups[groups.count - 1] = DayGroup(day: day, sets: groups[groups.count - 1].sets + [set])
      } else {
        groups.append(DayGroup(day: day, sets: [set]))
      }
    }
    return groups
  }
}
