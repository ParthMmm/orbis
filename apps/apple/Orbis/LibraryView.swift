import OrbisDesign
import SwiftUI

/// One list for both destinations, so loading, failure, and the two empty cases are defined
/// once and wear the same design. The two empty cases stay separate because they mean
/// different things.
struct SetList: View {
    let state: Loadable<[SavedSet]>
    let heading: String
    let emptyTitle: String
    let emptyMessage: String
    let emptySymbol: String
    let emptyIdentifier: String
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
                    ContentUnavailableView {
                        Label(emptyTitle, systemImage: emptySymbol)
                    } description: {
                        Text(emptyMessage)
                    }
                    .accessibilityIdentifier(emptyIdentifier)
                } else {
                    rows(sets)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.orbis.paper)
    }

    private func rows(_ sets: [SavedSet]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(heading)
                    .font(.orbis.sectionTitle)
                    .padding(.bottom, 12)
                VStack(spacing: 0) {
                    ForEach(Array(sets.enumerated()), id: \.element.id) { index, set in
                        let model = SetPresentation.row(set, index: index)
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
                Text(sets.count == 1 ? "1 set" : "\(sets.count) sets")
                    .font(.orbis.mono)
                    .foregroundStyle(.secondary)
                    .padding(.top, 10)
            }
            .padding()
        }
        .accessibilityIdentifier("library-list")
    }
}
