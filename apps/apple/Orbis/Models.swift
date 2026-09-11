import Foundation

/// Mirrors the server contract. Only the fields the Library needs are decoded, so a
/// server that adds a field does not break this client.
struct SavedSet: Identifiable, Decodable, Hashable {
    let id: String
    let url: String
    let title: String
    let source: SetSource
    let tags: [String]
    let createdAt: String
    let creator: String?
    let artworkUrl: String?
    let durationSeconds: Int?
    let metadataState: String
    let downloadState: String
    let playbackPositionSeconds: Int
    let listenCount: Int
    let finishCount: Int
    let lastListenedAt: String?
}

enum SetSource: String, Decodable, Hashable {
    case youtube
    case soundcloud

    var label: String {
        switch self {
        case .youtube: "YouTube"
        case .soundcloud: "SoundCloud"
        }
    }
}

struct LibraryResponse: Decodable {
    let sets: [SavedSet]
}

struct HealthResponse: Decodable {
    let status: String
}

/// The save request. `tags` goes out empty on the first save, and the server takes the title,
/// the creator, and the rest from the link, so a save needs nothing the person has not typed.
struct SaveSetRequest: Encodable {
    let tags: [String]
    let url: String
}
