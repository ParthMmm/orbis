import Foundation
import OrbisDesign

/// Everything the design system's row needs, derived from one Set. A value rather than a view
/// so the mapping is testable without rendering anything.
struct SetRowModel {
    let index: Int
    let source: String
    let title: String
    let url: String
    let tags: [SetRow.Tag]
    let added: Date
    let state: SetRow.State?
}

enum SetPresentation {
    /// The design package defaults its types to the main actor, so the mapper that builds them
    /// is main actor too. The row shows its ordinal, counted from one, so a list position
    /// becomes an ordinal here rather than at every call site.
    @MainActor
    static func row(
        _ set: SavedSet, position: Int, activeTag: String? = nil
    ) -> SetRowModel {
        SetRowModel(
            index: position + 1,
            source: set.source.label,
            title: set.title,
            url: displayURL(set.url),
            tags: set.tags.map { SetRow.Tag($0, category(for: $0)) },
            added: date(from: set.createdAt),
            state: state(of: set)
        )
    }

    /// The design shows the link without a scheme or `www.`, because it is there to be
    /// recognised, not followed.
    static func displayURL(_ raw: String) -> String {
        var text = raw
        for prefix in ["https://", "http://"] where text.hasPrefix(prefix) {
            text.removeFirst(prefix.count)
        }
        if text.hasPrefix("www.") {
            text.removeFirst(4)
        }
        return text
    }

    /// A Tag's colour is its identity, so it must not change between launches or reorder as
    /// other tags come and go. A stable hash keeps it deterministic and independent of the set.
    static func category(for tag: String) -> OrbisColor.Category {
        let cases = OrbisColor.Category.allCases
        var hash = 5381
        for byte in tag.utf8 {
            hash = ((hash << 5) &+ hash) &+ Int(byte)
        }
        return cases[Int(hash.magnitude % UInt(cases.count))]
    }

    @MainActor
    static func state(of set: SavedSet) -> SetRow.State? {
        let state = SetRow.State(
            resumeAt: set.playbackPositionSeconds > 0 ? set.playbackPositionSeconds : nil,
            download: downloadLabel(set.downloadState)
        )
        return state.isEmpty ? nil : state
    }

    static func downloadLabel(_ downloadState: String) -> String? {
        switch downloadState {
        case "queued": "Download queued"
        case "downloading": "Downloading"
        case "ready": "Audio ready"
        case "failed": "Download failed"
        case "canceled": "Download canceled"
        default: nil
        }
    }

    static func date(from timestamp: String) -> Date {
        let candidates: [ISO8601DateFormatter.Options] = [
            [.withInternetDateTime, .withFractionalSeconds],
            [.withInternetDateTime],
        ]
        for options in candidates {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            if let parsed = formatter.date(from: timestamp) {
                return parsed
            }
        }
        return .distantPast
    }
}
