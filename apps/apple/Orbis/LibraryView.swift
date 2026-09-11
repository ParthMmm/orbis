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
    /// The tag the list is filtered by, so the row marks it as the active one.
    let activeTag: String?
    /// Filter controls shown beside the heading, absent on a screen that only reads.
    let filters: AnyView?
    /// A screen that files Sets puts its paste field here, so it scrolls with the rows and is
    /// absent on a screen that only reads, such as Search.
    let hero: AnyView?
    let footer: String
    let retry: () async -> Void

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                ProgressView("Loading library")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("library-loading")
            case let .failed(message):
                ContentUnavailableView {
                    Label("Cannot reach your library", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await retry() } }
                        .buttonStyle(OrbisPrimaryButtonStyle())
                        .accessibilityIdentifier("library-retry")
                }
                .accessibilityIdentifier("library-error")
            case let .loaded(sets):
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
                        SetRow(
                            index: model.index,
                            source: model.source,
                            title: model.title,
                            url: model.url,
                            tags: model.tags,
                            added: model.added,
                            state: model.state
                        )
                        .padding(.horizontal)
                        .accessibilityIdentifier("set-row-\(set.id)")
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
