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

    /// A Tag's colour is its identity. The rule lives in the design system, so a Tag looks the
    /// same in every app and in every preview. Main actor because the design package defaults its
    /// types to the main actor, like the other mappers here.
    @MainActor
    static func category(for tag: String) -> OrbisColor.Category {
        OrbisColor.Category.forTag(tag)
    }

    /// The link field speaks in three outcomes: a check in flight, a link the library already
    /// holds, and anything else the service refused.
    @MainActor
    static func linkState(isFiling: Bool, failure: OrbisError?) -> LinkFieldState {
        if isFiling { return .checking }
        guard let failure else { return .idle }
        return failure == .duplicate
            ? .duplicate(message: failure.message)
            : .invalid(message: failure.message)
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

    /// The line under a Set's title: who made it, how long it runs, when it arrived. Only the
    /// parts the service filled in, so a Set no provider could name shows a date and nothing else.
    static func subtitle(_ set: SavedSet) -> String? {
        var parts: [String] = []
        if let creator = set.creator, !creator.isEmpty {
            parts.append(creator)
        }
        if let seconds = set.durationSeconds, seconds > 0 {
            parts.append(length(seconds))
        }
        parts.append(added(set.createdAt))
        return parts.joined(separator: " · ")
    }

    static func length(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
    }

    static func added(_ timestamp: String) -> String {
        date(from: timestamp).formatted(.dateTime.month(.abbreviated).day())
    }

    /// The address Open hands to the system. A value rather than a call, so the intent can be
    /// checked without a browser and without leaving the app.
    static func sourceURL(_ set: SavedSet) -> URL? {
        LinkField.address(of: set.url)
    }

    /// Where playback left off, said the way a person says it, or nothing when it never started.
    static func playbackPosition(_ set: SavedSet) -> String? {
        guard set.playbackPositionSeconds > 0 else { return nil }
        return "\(length(set.playbackPositionSeconds)) in"
    }
}
