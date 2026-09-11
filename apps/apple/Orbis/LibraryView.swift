import OrbisDesign
import SwiftUI

/// One list for both destinations, so the loading, failure, and empty treatments are
/// defined once. The two empty cases stay distinct because they mean different things.
struct SetList: View {
    let state: Loadable<[SavedSet]>
    let emptyTitle: String
    let emptyMessage: String
    let emptySymbol: String
    let emptyIdentifier: String
    let retry: () async -> Void

    var body: some View {
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
                List(sets) { item in
                    SetRowView(item: item)
                }
                .accessibilityIdentifier("library-list")
            }
        }
    }
}

struct SetRowView: View {
    let item: SavedSet

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            artwork
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.headline)
                Text(item.creator ?? item.source.label)
                    .font(.subheadline)
                    .foregroundStyle(OrbisColor.muted)
                if !item.tags.isEmpty {
                    Text(item.tags.map { "#\($0)" }.joined(separator: " "))
                        .font(.caption)
                        .foregroundStyle(OrbisColor.muted)
                }
                if showsProgress {
                    HStack(spacing: 10) {
                        if item.playbackPositionSeconds > 0 {
                            Text("Resume at \(Self.clock(item.playbackPositionSeconds))")
                        }
                        if item.downloadState != "none" {
                            Text(downloadLabel)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(OrbisColor.muted)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("set-row-\(item.id)")
    }

    private var artwork: some View {
        Group {
            if let artworkUrl = item.artworkUrl, let url = URL(string: artworkUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    fallbackArtwork
                }
            } else {
                fallbackArtwork
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: Radius.chip))
        .orbisRaised(radius: Radius.chip)
    }

    private var fallbackArtwork: some View {
        ZStack {
            Rectangle().fill(OrbisColor.field)
            Image(systemName: item.source == .youtube ? "play.rectangle" : "waveform")
                .foregroundStyle(OrbisColor.muted)
        }
    }

    private var showsProgress: Bool {
        item.playbackPositionSeconds > 0 || item.downloadState != "none"
    }

    private var downloadLabel: String {
        switch item.downloadState {
        case "queued": "Download queued"
        case "downloading": "Downloading"
        case "ready": "Retained audio ready"
        case "failed": "Download failed"
        case "canceled": "Download canceled"
        default: item.downloadState
        }
    }

    static func clock(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let remainder = seconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, remainder)
        }
        return String(format: "%d:%02d", minutes, remainder)
    }
}
