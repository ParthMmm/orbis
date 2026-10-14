import Foundation

struct SavedSet: Identifiable, Decodable, Hashable {
  enum CodingKeys: String, CodingKey {
    case id, url, title, source, tags, createdAt, releasedAt, creator, creatorId, artworkUrl, durationSeconds
    case artworkLargeUrl
    case metadataState, downloadState, playlistIds, playbackPositionSeconds
    case listenCount, finishCount, lastListenedAt
    case tracklistState
  }

  let id: String
  let url: String
  let title: String
  let source: SetSource
  let tags: [String]
  let createdAt: String
  let releasedAt: String?
  let creator: String?
  var creatorId: String? = nil
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
  var tracklistState: TracklistState = .none
}

extension SavedSet {
  var resumePosition: TimeInterval { TimeInterval(playbackPositionSeconds) }
}

extension SavedSet {
  init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    url = try values.decode(String.self, forKey: .url)
    title = try values.decode(String.self, forKey: .title)
    source = try values.decode(SetSource.self, forKey: .source)
    tags = try values.decode([String].self, forKey: .tags)
    createdAt = try values.decode(String.self, forKey: .createdAt)
    releasedAt = try values.decodeIfPresent(String.self, forKey: .releasedAt)
    creator = try values.decodeIfPresent(String.self, forKey: .creator)
    creatorId = try values.decodeIfPresent(String.self, forKey: .creatorId)
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
    tracklistState = try values.decodeIfPresent(TracklistState.self, forKey: .tracklistState) ?? .none
  }
}

enum TracklistState: String, Decodable, Hashable {
  case pending
  case ready
  case none
  case failed

  init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: raw) ?? .none
  }
}

struct Cue: Decodable, Equatable, Identifiable {
  let position: Int
  let startSeconds: TimeInterval?
  let artist: String
  let title: String
  let appleMusicId: String?
  let artworkUrl: String?

  var id: Int { position }
}

struct Tracklist: Decodable, Equatable {
  let state: TracklistState
  let cues: [Cue]
}

enum SetSource: Hashable, Decodable {
  case youtube
  case soundcloud
  case unknown(String)

  var label: String {
    switch self {
    case .youtube: "YouTube"
    case .soundcloud: "SoundCloud"
    case .unknown(let name): name
    }
  }

  static func named(by url: URL) -> SetSource? {
    guard let host = url.host()?.lowercased() else { return nil }
    let youTube = [
      "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
    ]
    if youTube.contains(host) { return .youtube }
    // The SoundCloud app shares `on.soundcloud.com` short links; the service follows them.
    let soundCloud = [
      "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com",
    ]
    if soundCloud.contains(host) { return .soundcloud }
    return nil
  }
}

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

struct AudioState: Decodable, Equatable {
  let state: String
  let bytesReceived: Int
  let bytesTotal: Int?
  let format: String?
}

struct Playlist: Identifiable, Decodable, Hashable {
  let id: String
  let name: String
  let setCount: Int
}

struct PlaylistsResponse: Decodable {
  let playlists: [Playlist]
}

struct ListeningQueue: Decodable, Equatable {
  let activeSetId: String?
  let entries: [SavedSet]

  var active: SavedSet? { entries.first { $0.id == activeSetId } }

  func isActive(_ id: String) -> Bool { id == activeSetId }
}

struct QueueResponse: Decodable {
  let queue: ListeningQueue
}

struct SaveSetRequest: Encodable {
  let tags: [String]
  let url: String
}

struct SetTitleRequest: Encodable {
  let title: String
}

struct SetTagsRequest: Encodable {
  let tags: [String]
}

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

struct PlaybackPositionRequest: Encodable {
  let seconds: Int
}
