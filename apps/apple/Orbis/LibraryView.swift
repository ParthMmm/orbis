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
  /// The Tags the list is filtered by, which every row carries and so leaves out.
  var hiddenTags: [String] = []
  /// Filter controls shown beside the heading, absent on a screen that only reads.
  let filters: AnyView?
  /// The state a filter shows when it admits nothing. A screen that can narrow its list
  /// supplies it, so a collection that is empty and a collection the person has filtered
  /// down to nothing never wear each other's copy.
  let noMatches: AnyView?
  /// A screen that files Sets puts its paste field here, so it scrolls with the rows and is
  /// absent on a screen that only reads, such as Search.
  let hero: AnyView?
  var aboveRows: AnyView?
  /// A screen with a collection can put its horizontal rails — the recently filed, the
  /// playlists — between the hero and the list header, the way a music app's home carries its
  /// sections. Absent on a screen that only reads.
  var rails: AnyView?
  /// What follows the rows, such as the tracks a search found inside Tracklists.
  var belowRows: AnyView?
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
  /// False when the list is in an order other than the day each Set was filed, where grouping
  /// by day would scatter one day across the list.
  var groupsByDay = true
  /// The Tags a row's long-press menu offers to put on or take off, and what that does. Absent
  /// on a screen that only reads, such as Search.
  var menuTags: [String] = []
  var toggleTag: ((SavedSet, String) -> Void)?
  var editTags: ((SavedSet) -> Void)?
  /// The Sets picked while the list is in selection mode, or nil when it is not. A row then
  /// toggles its Set instead of opening or playing it.
  var selection: Set<String>?
  var toggleSelection: ((SavedSet) -> Void)?
  /// What the page takes its light from: a Set's artwork, blurred behind the top of the list,
  /// plain paper, or nothing, when the list is one column of a page that draws the light itself.
  var backdrop: Backdrop = .paper

  enum Backdrop {
    case paper
    case artwork(URL?)
    case none
  }

  @Environment(\.openURL) private var openURL
  /// The rows under their headings, built when the Sets change rather than on every render,
  /// because grouping parses each Set's date.
  @State private var groups: [DayGroup] = []

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
        if sets.isEmpty, aboveRows == nil {
          emptyPresentation
        } else {
          rows
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onChange(of: state, initial: true) { regroup() }
    .onChange(of: groupsByDay) { regroup() }
    .background {
      switch backdrop {
      case .paper: Color.orbis.paper.ignoresSafeArea()
      case .artwork(let url): ArtworkGlow(url: url, reach: 0.55)
      case .none: Color.clear
      }
    }
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
        if let rails {
          rails.padding(.bottom, 20)
        }
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

  /// The heading and the line that carries the count and the filters. The rows and the
  /// no-matches state share it, because both are answers about the same list.
  private var listHeader: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let heading {
        heading
          .font(.orbis.sectionTitle)
          .padding(.bottom, 12)
      }
      HStack(alignment: .firstTextBaseline) {
        ListingLabel(footer)
        Spacer()
        if let filters {
          filters
        }
      }
      .padding(.vertical, 12)
    }
  }

  private var rows: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let aboveRows {
          aboveRows.padding(.bottom, 20)
        }
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
          ForEach(groups) { group in
            if let label = group.label {
              ListingHeader(label)
            }
            ForEach(Array(group.sets.enumerated()), id: \.element.id) { index, set in
              row(set)
                .padding(.top, index > 0 ? 8 : 0)
            }
          }
        }
        if let belowRows {
          belowRows.padding(.top, 28)
        }
      }
      .padding()
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .scrollEdgeEffectStyle(.soft, for: .bottom)
    .accessibilityIdentifier(listIdentifier)
  }

  @ViewBuilder private func row(_ set: SavedSet) -> some View {
    if let selection, let toggleSelection {
      selectableRow(set, isSelected: selection.contains(set.id)) { toggleSelection(set) }
    } else {
      openableRow(set)
    }
  }

  /// The row in selection mode: one target, with nothing that plays or opens.
  private func selectableRow(
    _ set: SavedSet, isSelected: Bool, toggle: @escaping () -> Void
  ) -> some View {
    let model = SetPresentation.row(set)
    return Button(action: toggle) {
      HStack(spacing: 12) {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
          .font(.title2)
          .foregroundStyle(isSelected ? Color.orbis.tint : Color.secondary)
          .orbisSymbolReplace()
        SetRow(
          title: model.title,
          source: model.source,
          artwork: model.artwork,
          creator: model.creator,
          length: model.length,
          tags: model.tags,
          hiddenTags: hiddenTags,
          state: model.state,
          progress: model.progress
        )
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .accessibilityIdentifier("set-row-\(set.id)")
  }

  /// One Set. The row owns both of its targets: the artwork plays and the rest opens. The
  /// long-press menu repeats both, and adds the Source Link, for anyone who reaches for it.
  private func openableRow(_ set: SavedSet) -> some View {
    let model = SetPresentation.row(set)
    let playback = SetPresentation.playback(
      of: set, currentSetId: currentSetId, isPlaying: isPlaying)
    return SetRow(
      title: model.title,
      source: model.source,
      artwork: model.artwork,
      creator: model.creator,
      length: model.length,
      tags: model.tags,
      hiddenTags: hiddenTags,
      state: model.state,
      progress: model.progress,
      playback: playback,
      togglePlayback: togglePlayback.map { toggle in { toggle(set) } },
      select: select.map { select in { select(set) } }
    )
    .zoomsSetPage(set.id)
    .accessibilityIdentifier("set-row-\(set.id)")
    .contextMenu {
      if let playback, let togglePlayback {
        Button(playback.label, systemImage: playback.symbol) { togglePlayback(set) }
      }
      // "Open" is the Source Link's word on this page, so the page itself is "Details".
      if let select {
        Button("Details", systemImage: "info.circle") { select(set) }
      }
      if let toggleTag {
        Menu("Tags", systemImage: "tag") {
          ForEach(menuTags.prefix(Self.menuTagLimit), id: \.self) { tag in
            Toggle(
              tag,
              isOn: Binding(get: { set.tags.contains(tag) }, set: { _ in toggleTag(set, tag) }))
          }
          if let editTags {
            Divider()
            Button("Edit Tags…", systemImage: "pencil") { editTags(set) }
          }
        }
      }
      Button("Open Source", systemImage: "safari") { open(set) }
    }
  }

  private static let menuTagLimit = 8

  private func regroup() {
    guard case .loaded(let sets) = state else {
      groups = []
      return
    }
    groups = groupsByDay ? Self.days(of: sets) : [DayGroup(id: .distantPast, label: nil, sets: sets)]
  }

  /// The Sets in the order given, grouped under the day each was filed.
  struct DayGroup: Identifiable {
    /// The start of the day. The label leaves out the year, so the same date in two years would
    /// share it; the day itself does not.
    let id: Date
    /// The heading, absent when the list is not grouped.
    let label: String?
    var sets: [SavedSet]
  }

  static func days(of sets: [SavedSet]) -> [DayGroup] {
    let calendar = Calendar.current
    var groups: [DayGroup] = []
    for set in sets {
      let day = calendar.startOfDay(for: SetPresentation.date(from: set.createdAt))
      if groups.last?.id == day {
        groups[groups.count - 1].sets.append(set)
      } else {
        groups.append(DayGroup(id: day, label: SetPresentation.day(day), sets: [set]))
      }
    }
    return groups
  }
}
