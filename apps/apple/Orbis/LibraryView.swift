import OrbisDesign
import SwiftUI

struct SetList: View {
  let state: Loadable<[SavedSet]>
  let heading: Text?
  let empty: AnyView
  var failureContext = "loading the library"
  let activeTag: String?
  let filters: AnyView?
  let noMatches: AnyView?
  let hero: AnyView?
  var aboveRows: AnyView?
  var rails: AnyView?
  var belowRows: AnyView?
  let footer: String
  let retry: () async -> Void
  var listIdentifier = "library-list"
  var select: ((SavedSet) -> Void)?
  var currentSetId: String?
  var isPlaying = false
  var togglePlayback: ((SavedSet) -> Void)?
  var groupsByDay = true
  var backdrop: Backdrop = .paper

  enum Backdrop {
    case paper
    case artwork(URL?)
    case none
  }

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
        if sets.isEmpty, aboveRows == nil {
          emptyPresentation
        } else {
          rows(sets)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background {
      switch backdrop {
      case .paper: Color.orbis.paper.ignoresSafeArea()
      case .artwork(let url): ArtworkGlow(url: url, reach: 0.55)
      case .none: Color.clear
      }
    }
  }

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
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(groupsByDay ? Self.days(of: sets) : [DayGroup(day: "", sets: sets)], id: \.day) {
            group in
            if !group.day.isEmpty {
              ListingHeader(group.day)
            }
            ForEach(Array(group.sets.enumerated()), id: \.element.id) { index, set in
              if index > 0 {
                Divider()
              }
              row(set)
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
      dates: SetPresentation.datesLine(set),
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
      if let select {
        Button("Details", systemImage: "info.circle") { select(set) }
      }
      Button("Open Source", systemImage: "safari") { open(set) }
    }
  }

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
