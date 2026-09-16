import Foundation

/// Mirrors the server contract. Only the fields the Library needs are decoded, so a
/// server that adds a field does not break this client.
struct SavedSet: Identifiable, Decodable, Hashable {
  enum CodingKeys: String, CodingKey {
    case id, url, title, source, tags, createdAt, creator, artworkUrl, durationSeconds
    case artworkLargeUrl
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
  let artworkLargeUrl: String?
  let durationSeconds: Int?
  let metadataState: String
  let downloadState: String
  let playlistIds: [String]
  let playbackPositionSeconds: Int
  let listenCount: Int
  let finishCount: Int
  let lastListenedAt: String?
}

extension SavedSet {
  /// Where playback should start for this Set: where the last Listen left off, or the beginning
  /// for a Set nobody has heard, which is also where a finished one starts again.
  var resumePosition: TimeInterval { TimeInterval(playbackPositionSeconds) }
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
    artworkLargeUrl = try values.decodeIfPresent(String.self, forKey: .artworkLargeUrl)
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

enum SetSource: Hashable, Decodable {
  case youtube
  case soundcloud
  /// The service named a source this build does not know. The Set stays readable and
  /// shows the name the service used, because a source arriving later than the app is a
  /// version skew, not a broken library.
  case unknown(String)

  var label: String {
    switch self {
    case .youtube: "YouTube"
    case .soundcloud: "SoundCloud"
    case .unknown(let name): name
    }
  }

  /// Which service a link names, or nil when Orbis takes neither.
  ///
  /// Only the host is judged here, so a paste is refused without asking the service. The shape of
  /// the path stays the service's judgement: it owns that rule, and its refusal reaches the field
  /// in its own words rather than a second copy of the rule going stale in the app.
  static func named(by url: URL) -> SetSource? {
    guard let host = url.host()?.lowercased() else { return nil }
    let youTube = [
      "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
    ]
    if youTube.contains(host) { return .youtube }
    let soundCloud = ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]
    if soundCloud.contains(host) { return .soundcloud }
    return nil
  }
}

/// The decode is written out because a source the app does not know must not fail the Set
/// it rides on. A closed enum turned one new word from the service into a library that
/// would not decode at all, and the silent decode that reported it hid the reason.
extension SetSource {
  init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    switch raw {
    case "youtube": self = .youtube
    case "soundcloud": self = .soundcloud
    case let name: self = .unknown(name)
    }
  }
}

struct LibraryResponse: Decodable {
  let sets: [SavedSet]
}

/// How far a download has got. Bytes are the worker's own count, because a converted
/// tunnel carries no content length; the format is what the worker stored, if anything.
struct AudioState: Decodable, Equatable {
  let state: String
  let bytesReceived: Int
  let bytesTotal: Int?
  let format: String?
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

/// The one Listening Queue, in play order. `activeSetId` is the Set playing now, and at most one
/// entry ever matches it.
struct ListeningQueue: Decodable, Equatable {
  let activeSetId: String?
  let entries: [SavedSet]

  /// The Set playing now, if any. A queue with entries but no active Set is a queue nobody has
  /// started yet.
  var active: SavedSet? { entries.first { $0.id == activeSetId } }

  func isActive(_ id: String) -> Bool { id == activeSetId }
}

/// Every queue request answers with the queue itself, so a change is read back from the service
/// rather than assumed from locally applied rules.
struct QueueResponse: Decodable {
  let queue: ListeningQueue
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

struct CreatePlaylistRequest: Encodable {
  let name: String
}

struct PlaylistNameRequest: Encodable {
  let name: String
}

struct PlaylistMembersRequest: Encodable {
  let setIds: [String]
}

struct PlaylistMembersResponse: Decodable {
  let sets: [SavedSet]
}

/// Where a queued Set goes: `next` starts after the active Set, `end` goes last.
enum QueuePlacement: String {
  case next
  case end
}

struct SetIdRequest: Encodable {
  let setId: String
}

struct QueueEntryRequest: Encodable {
  let placement: String
  let setId: String
}

struct PlaylistQueueRequest: Encodable {
  let playlistId: String
}

/// A Playback Position in whole seconds. The service bounds it to the Set's own length.
struct PlaybackPositionRequest: Encodable {
  let seconds: Int
}
