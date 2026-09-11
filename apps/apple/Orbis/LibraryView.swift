import OrbisDesign
import SwiftUI

/// The copy a list shows when it has nothing to render. Grouped so a caller passes one value
/// instead of four loose strings.
struct EmptyPresentation {
  let title: String
  let message: String
  let symbol: String
  let identifier: String
}

/// One list for both destinations, so loading, failure, and the two empty cases are defined
/// once and wear the same design. The two empty cases stay separate because they mean
/// different things.
struct SetList: View {
  let state: Loadable<[SavedSet]>
  let heading: Text
  let empty: EmptyPresentation
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
        ProgressView("Loading library")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityIdentifier("library-loading")
      case .failed(let failure):
        ContentUnavailableView {
          Label(failure.title, systemImage: failure.symbol)
        } description: {
          Text(failure.message)
        } actions: {
          if failure.isRetryable {
            Button("Try again") { Task { await retry() } }
              .buttonStyle(OrbisPrimaryButtonStyle())
              .accessibilityIdentifier("library-retry")
          }
          CopyFailureButton(
            report: FailureReport(failure: failure, context: failureContext))
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
          emptyMessageView.frame(maxWidth: .infinity)
        }
        .padding()
      }
    } else {
      emptyMessageView
    }
  }

  private func open(_ set: SavedSet) {
    guard let link = SetPresentation.sourceURL(set) else { return }
    openURL(link)
  }

  private var emptyMessageView: some View {
    ContentUnavailableView {
      Label(empty.title, systemImage: empty.symbol)
    } description: {
      Text(empty.message)
    }
    .accessibilityIdentifier(empty.identifier)
  }

  private func rows(_ sets: [SavedSet]) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let hero {
          hero.padding(.bottom, 16)
        }
        HStack(alignment: .firstTextBaseline) {
          heading
            .font(.orbis.sectionTitle)
          Spacer()
          if let filters {
            filters
          }
        }
        .padding(.bottom, 12)
        VStack(spacing: 0) {
          ForEach(Array(sets.enumerated()), id: \.element.id) { index, set in
            let model = SetPresentation.row(
              set, position: index, activeTag: activeTag
            )
            let row = SetRow(
              index: model.index,
              source: model.source,
              title: model.title,
              url: model.url,
              tags: model.tags,
              added: model.added,
              state: model.state
            )
            .padding(.horizontal)
            .contentShape(.rect)
            .accessibilityIdentifier("set-row-\(set.id)")
            .contextMenu {
              Button("Open Source") { open(set) }
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
            if index < sets.count - 1 {
              Divider().padding(.leading)
            }
          }
        }
        .padding(.vertical, 6)
        .orbisRaised()
        Text(footer)
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
          .padding(.top, 10)
      }
      .padding()
    }
    .accessibilityIdentifier("library-list")
  }
}
