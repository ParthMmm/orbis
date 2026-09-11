import Foundation

/// Mirrors the server contract. Only the fields the Library needs are decoded, so a
/// server that adds a field does not break this client.
struct SavedSet: Identifiable, Decodable, Hashable {
    enum CodingKeys: String, CodingKey {
        case id, url, title, source, tags, createdAt, creator, artworkUrl, durationSeconds
        case metadataState, downloadState, playlistIds, playbackPositionSeconds
        case listenCount, finishCount, lastListenedAt
    }

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
    let playlistIds: [String]
    let playbackPositionSeconds: Int
    let listenCount: Int
    let finishCount: Int
    let lastListenedAt: String?
}

/// The decode is written out rather than left to the compiler for one reason: `playlistIds` is
/// read as empty when it is absent.
///
/// A service and an app upgrade on their own schedules. When the field arrived, every Set from
/// the older service failed to decode, which turned a version skew into "cannot reach your
/// library" on both platforms with a Try again button that could never work. A field that is
/// missing because the service predates it is not worth making someone's library unreadable.
extension SavedSet {
    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        url = try values.decode(String.self, forKey: .url)
        title = try values.decode(String.self, forKey: .title)
        source = try values.decode(SetSource.self, forKey: .source)
        tags = try values.decode([String].self, forKey: .tags)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        creator = try values.decodeIfPresent(String.self, forKey: .creator)
        artworkUrl = try values.decodeIfPresent(String.self, forKey: .artworkUrl)
        durationSeconds = try values.decodeIfPresent(Int.self, forKey: .durationSeconds)
        metadataState = try values.decode(String.self, forKey: .metadataState)
        downloadState = try values.decode(String.self, forKey: .downloadState)
        playlistIds = try values.decodeIfPresent([String].self, forKey: .playlistIds) ?? []
        playbackPositionSeconds = try values.decode(Int.self, forKey: .playbackPositionSeconds)
        listenCount = try values.decode(Int.self, forKey: .listenCount)
        finishCount = try values.decode(Int.self, forKey: .finishCount)
        lastListenedAt = try values.decodeIfPresent(String.self, forKey: .lastListenedAt)
    }
}

enum SetSource: String, Decodable, Hashable {    case youtube
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

/// Mirrors the server contract. The count comes from the server so a sidebar does not ask once
/// per playlist, and the creation date is left out because nothing shows it.
struct Playlist: Identifiable, Decodable, Hashable {
    let id: String
    let name: String
    let setCount: Int
}

struct PlaylistsResponse: Decodable {
    let playlists: [Playlist]
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

/// The two edits the reveal makes. The service caps a title at 200 characters, so a longer one
/// is cut rather than refused.
struct SetTitleRequest: Encodable {
    let title: String
}

struct SetTagsRequest: Encodable {
    let tags: [String]
}

/// The Playlists a Set belongs to. The service treats this as the whole membership, so naming
/// another Playlist moves the Set rather than adding a second one.
struct SetPlaylistsRequest: Encodable {
    let playlistIds: [String]
}
