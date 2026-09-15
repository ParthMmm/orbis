import OrbisDesign
import SwiftUI

/// One list for both destinations, so loading, failure, and the empty cases are defined once
/// and wear the same design. The states themselves come from OrbisDesign; this view decides
/// where they sit and what they are called.
struct SetList: View {
  let state: Loadable<[SavedSet]>
  let heading: Text
  /// The state a loaded-but-empty list shows, composed by the caller from OrbisDesign and
  /// carrying its own accessibility identifier.
  let empty: AnyView
  /// What the app was doing when a failure happened, in the words the screen would use.
  var failureContext = "loading the library"
  /// The tag the list is filtered by, so the row marks it as the active one.
  let activeTag: String?
  /// Filter controls shown beside the heading, absent on a screen that only reads.
  let filters: AnyView?
  /// A screen that files Sets puts its paste field here, so it scrolls with the rows and is
  /// absent on a screen that only reads, such as Search.
  let hero: AnyView?
  let footer: String
  let retry: () async -> Void
  /// A screen that opens a Set puts its action here, so a row knows it can be pressed and a
  /// screen that only reads does not pretend otherwise.
  var select: ((SavedSet) -> Void)?

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

  /// An empty Library keeps the paste field, so filing the first Set never means hunting for
  /// a control that disappeared when the list emptied.
  @ViewBuilder
  private var emptyPresentation: some View {
    if let hero {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          hero.padding(.bottom, 16)
          empty.frame(maxWidth: .infinity)
        }
        .padding()
      }
    } else {
      empty
    }
  }

  private func open(_ set: SavedSet) {
    guard let link = SetPresentation.sourceURL(set) else { return }
    openURL(link)
  }

  private func rows(_ sets: [SavedSet]) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let hero {
          hero.padding(.bottom, 16)
        }
        heading
          .font(.orbis.sectionTitle)
          .padding(.bottom, 12)
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
        // The list can hold a whole library, so rows are built as they scroll into view
        // rather than all at once. Sets group under the day they were filed, so the date is
        // structure rather than a value on every row.
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Self.days(of: sets), id: \.day) { group in
            ListingHeader(group.day)
            ForEach(Array(group.sets.enumerated()), id: \.element.id) { index, set in
              let model = SetPresentation.row(set, activeTag: activeTag)
              let row = SetRow(
                title: model.title,
                source: model.source,
                artwork: model.artwork,
                creator: model.creator,
                length: model.length,
                tags: model.tags,
                activeTag: activeTag,
                state: model.state,
                progress: model.progress
              )
              .contentShape(.rect)
              .accessibilityIdentifier("set-row-\(set.id)")
              .contextMenu {
                Button("Open Source") { open(set) }
              }
              if index > 0 {
                Divider()
              }
              if let select {
                Button {
                  select(set)
                } label: {
                  row
                }
                .buttonStyle(.plain)
              } else {
                row
              }
            }
          }
        }
      }
      .padding()
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier("library-list")
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
