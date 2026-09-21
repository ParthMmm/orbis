import Foundation
import OrbisDesign

/// A failure the user can act on. Each case carries the sentence the app shows, so the
/// recovery action is decided in one place rather than in every view.
enum OrbisError: Error, Equatable {
  case unreachable
  case notPaired
  case refused
  case duplicate
  /// The view that started the request went away before it finished. Not a failure, and never
  /// shown to anyone, because the screen that replaces it loads on its own.
  case cancelled
  case server(status: Int, message: String)
  case malformed
  /// A web server answered instead of Orbis. Usually the address is missing the port the
  /// service runs on, which is worth saying rather than calling the answer unreadable.
  case notOrbis
  /// The device refused to hold the pairing, so nothing was saved and nothing was changed.
  case storageRefused
  case badAddress

  var message: String {
    switch self {
    case .unreachable:
      "Cannot reach your library. Check that Tailscale is connected and the Orbis service is running on the host."
    case .notPaired:
      "This device is not paired with your library. Pair it on the host and enter the new token."
    case .refused:
      "The service refused the request. Check the address points at your Orbis service."
    case .duplicate:
      "That set is already in your library."
    case .cancelled:
      "The request was interrupted."
    case .server(let status, let message):
      "The service reported \(status). \(message)"
    case .malformed:
      "The service sent a response this app does not understand. Update the app."
    case .notOrbis:
      "Something answered at that address, but it was not Orbis. A web page came back instead."
    case .storageRefused:
      "This device would not save the pairing, so nothing was changed. Try again."
    case .badAddress:
      "Enter the full service address, including https://."
    }
  }
}

extension OrbisError {
  /// `address` is where the app was looking. Anything other than Orbis answering is the first
  /// thing worth knowing, and the person reading the screen can check it in one look.
  func failure(at address: URL? = nil) -> OrbisFailure {
    var failure: OrbisFailure
    switch self {
    case .unreachable:
      failure = OrbisFailure(
        title: "Cannot reach your library",
        message: message,
        symbol: "wifi.exclamationmark",
        isRetryable: true
      )
    case .notPaired:
      failure = OrbisFailure(
        title: "This device is not paired",
        message: message,
        symbol: "key.slash",
        isRetryable: false
      )
    case .refused:
      failure = OrbisFailure(
        title: "The service refused the request",
        message: message,
        symbol: "hand.raised",
        isRetryable: false
      )
    case .malformed:
      failure = OrbisFailure(
        title: "That address is not your library",
        message:
          "\(message) Check that the address points at Orbis itself, and that the service is not older or newer than this app.",
        symbol: "doc.questionmark",
        isRetryable: false
      )
    case .server(let status, _):
      failure = OrbisFailure(
        title: "Your library reported an error",
        message: message,
        symbol: "exclamationmark.triangle",
        isRetryable: status >= 500
      )
    case .notOrbis:
      failure = OrbisFailure(
        title: "That address is a web page, not Orbis",
        message:
          "\(message) Check that the address carries the port your Orbis service runs on, because a bare host name is usually answered by whatever else runs there.",
        symbol: "globe",
        isRetryable: false
      )
    case .storageRefused:
      failure = OrbisFailure(
        title: "This device could not save the pairing",
        message: message,
        symbol: "key.slash",
        isRetryable: true
      )
    case .badAddress:
      failure = OrbisFailure(
        title: "That is not a service address",
        message: message,
        symbol: "questionmark.circle",
        isRetryable: false
      )
    case .duplicate, .cancelled:
      failure = OrbisFailure(
        title: "Something went wrong",
        message: message,
        symbol: "exclamationmark.triangle",
        isRetryable: true
      )
    }
    failure.address = address?.absoluteString
    return failure
  }
}

/// Talks to the Orbis service. Every request carries the device token, and the same
/// failure mapping is used everywhere, so a view only has to render `message`.
struct OrbisClient: Sendable {
  let address: URL
  let token: String
  let session: URLSession

  init(address: URL, token: String, session: URLSession = .shared) {
    self.address = address
    self.token = token
    self.session = session
  }

  static func address(from input: String) throws -> URL {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), accepts(url) else {
      throw OrbisError.badAddress
    }
    return url
  }

  /// An address is accepted only when it would carry the pairing safely: TLS, or the
  /// loopback service the server itself trusts, which is what the temporary lane services
  /// run on.
  static func accepts(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
      return false
    }
    let loopback = ["127.0.0.1", "localhost", "::1", "[::1]"]
    return scheme == "https" || (scheme == "http" && loopback.contains(host))
  }

  /// Shared by every call, so one coder's configuration is the whole app's.
  private static let decoder = JSONDecoder()
  private static let encoder = JSONEncoder()

  func health() async throws -> String {
    let response = try await send(path: "health", method: "GET", body: nil)
    return try Self.decode(HealthResponse.self, from: response).status
  }

  func library(query: String = "", playlistId: String? = nil) async throws -> [SavedSet] {
    var items: [URLQueryItem] = []
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      items.append(URLQueryItem(name: "q", value: trimmed))
    }
    if let playlistId {
      items.append(URLQueryItem(name: "playlistId", value: playlistId))
    }
    var path = "sets"
    if !items.isEmpty {
      var components = URLComponents()
      components.queryItems = items
      path += "?\(components.percentEncodedQuery ?? "")"
    }
    let response = try await send(path: path, method: "GET", body: nil)
    return try Self.decode(LibraryResponse.self, from: response).sets
  }

  func playlists() async throws -> [Playlist] {
    let response = try await send(path: "playlists", method: "GET", body: nil)
    return try Self.decode(PlaylistsResponse.self, from: response).playlists
  }

  func createPlaylist(name: String) async throws -> Playlist {
    let body = try Self.encoder.encode(CreatePlaylistRequest(name: name))
    let response = try await send(path: "playlists", method: "POST", body: body)
    return try Self.decode(Playlist.self, from: response)
  }

  func renamePlaylist(_ id: String, name: String) async throws -> Playlist {
    let body = try Self.encoder.encode(PlaylistNameRequest(name: name))
    let response = try await send(path: "playlists/\(id)", method: "PATCH", body: body)
    return try Self.decode(Playlist.self, from: response)
  }

  func deletePlaylist(_ id: String) async throws -> Playlist {
    let response = try await send(path: "playlists/\(id)", method: "DELETE", body: nil)
    return try Self.decode(Playlist.self, from: response)
  }

  /// States the ordered Sets a Playlist holds. Removing a Set here leaves it in the Library.
  func setPlaylistMembers(_ id: String, setIds: [String]) async throws -> [SavedSet] {
    let body = try Self.encoder.encode(PlaylistMembersRequest(setIds: setIds))
    let response = try await send(path: "playlists/\(id)/sets", method: "PUT", body: body)
    return try Self.decode(PlaylistMembersResponse.self, from: response).sets
  }

  func save(url: String, tags: [String] = []) async throws -> SavedSet {
    let body = try Self.encoder.encode(SaveSetRequest(tags: tags, url: url))
    let response = try await send(path: "sets", method: "POST", body: body)
    return try decodedSet(response)
  }

  func updateTitle(_ id: String, title: String) async throws -> SavedSet {
    let body = try Self.encoder.encode(SetTitleRequest(title: title))
    let response = try await send(path: "sets/\(id)/title", method: "PATCH", body: body)
    return try decodedSet(response)
  }

  func updateTags(_ id: String, tags: [String]) async throws -> SavedSet {
    let body = try Self.encoder.encode(SetTagsRequest(tags: tags))
    let response = try await send(path: "sets/\(id)/tags", method: "PATCH", body: body)
    return try decodedSet(response)
  }

  /// Asks the service to name a Set it could not name when the link was filed.
  func retryMetadata(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)/metadata", method: "POST", body: nil)
    return try decodedSet(response)
  }

  /// States the Playlists a Set belongs to. Sending the whole membership is what lets the
  /// service work out which Playlist the Set left.
  func updatePlaylists(_ id: String, playlistIds: [String]) async throws -> SavedSet {
    let body = try Self.encoder.encode(SetPlaylistsRequest(playlistIds: playlistIds))
    let response = try await send(path: "sets/\(id)/playlists", method: "PUT", body: body)
    return try decodedSet(response)
  }

  func deleteSet(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)", method: "DELETE", body: nil)
    return try decodedSet(response)
  }

  /// Asks the service to fetch this Set's audio through Cobalt and keep it. The answer
  /// is the Set with its new download state; progress arrives through audioState.
  func requestAudioDownload(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)/audio/download", method: "POST", body: nil)
    return try decodedSet(response)
  }

  /// How far the service has got with this Set's audio, if it has started.
  func audioState(_ id: String) async throws -> AudioState {
    let response = try await send(path: "sets/\(id)/audio/state", method: "GET", body: nil)
    return try Self.decode(AudioState.self, from: response)
  }

  /// Stops a running download and drops its partial file. A finished download stays
  /// finished: the service refuses that with its own sentence.
  func cancelAudioDownload(_ id: String) async throws -> SavedSet {
    let response = try await send(path: "sets/\(id)/audio/download", method: "DELETE", body: nil)
    return try decodedSet(response)
  }

  /// The streaming address for a Set whose audio is ready. The token travels as a
  /// header on the asset, never in this URL.
  func audioFileURL(_ id: String) -> URL {
    address.appending(path: "sets/\(id)/audio")
  }

  private func decodedSet(_ response: Data) throws -> SavedSet {
    try Self.decode(SavedSet.self, from: response)
  }

  /// Decodes a body, reporting a shape this build cannot read as the one error the screens explain.
  /// The failing key path reaches the debug log and the values do not: a version skew is worth
  /// knowing by field, and the fields hold the library's own titles and links.
  private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do {
      return try decoder.decode(type, from: data)
    } catch {
      #if DEBUG
        if let decoding = error as? DecodingError {
          let line = "Orbis could not read \(T.self) at \(path(of: decoding))\n"
          FileHandle.standardError.write(Data(line.utf8))
        }
      #endif
      throw OrbisError.malformed
    }
  }

  /// Where a decode failed, as the fields leading to it. No value is named.
  private static func path(of error: DecodingError) -> String {
    let codingPath: [any CodingKey]
    switch error {
    case .keyNotFound(let key, let context):
      codingPath = context.codingPath + [key]
    case .typeMismatch(_, let context), .valueNotFound(_, let context),
      .dataCorrupted(let context):
      codingPath = context.codingPath
    @unknown default:
      codingPath = []
    }
    guard !codingPath.isEmpty else { return "the root" }
    return codingPath.map(\.stringValue).joined(separator: ".")
  }

  /// What a debug line may say about a request: method, host, and path, because a query string
  /// carries what the person typed.
  private static func redacted(method: String, url: URL) -> String {
    "\(method) \(url.host() ?? "") \(url.path())"
  }

  private func send(path: String, method: String, body: Data?) async throws -> Data {
    guard let url = URL(string: path, relativeTo: address) else {
      throw OrbisError.badAddress
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.timeoutInterval = 15
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch let error as URLError where error.code == .cancelled {
      throw OrbisError.cancelled
    } catch {
      #if DEBUG
        // A transport failure is otherwise invisible, which makes a wrong address, a
        // blocked connection, and a rejected certificate look identical. Written to
        // standard error because stdout is buffered and a killed run loses it. The
        // error is named by its code: its own description carries the URL back in.
        let code = (error as? URLError)?.code.rawValue ?? -1
        let line = "Orbis transport failure \(Self.redacted(method: method, url: url)): URLError \(code)\n"
        FileHandle.standardError.write(Data(line.utf8))
      #endif
      throw OrbisError.unreachable
    }
    guard let http = response as? HTTPURLResponse else {
      throw OrbisError.malformed
    }
    let head = data.prefix(160)
    // Markup at any status means a web server answered, not Orbis. Reported before the status
    // is judged, because a 403 from a web page is not a refusal by the library.
    if head.first == UInt8(ascii: "<") {
      #if DEBUG
        let line = "Orbis read a web page from \(Self.redacted(method: method, url: url))\n"
        FileHandle.standardError.write(Data(line.utf8))
      #endif
      throw OrbisError.notOrbis
    }
    #if DEBUG
      // A body that is not JSON and not a web page is usually a version skew: something
      // answered in a shape this build does not know. Its size is printed rather than its
      // first bytes, which are the library's own.
      if head.first != UInt8(ascii: "{"), head.first != UInt8(ascii: "[") {
        let line =
          "Orbis read a non-JSON body from \(Self.redacted(method: method, url: url)): \(data.count) bytes\n"
        FileHandle.standardError.write(Data(line.utf8))
      }
    #endif
    switch http.statusCode {
    case 200..<300:
      return data
    case 401:
      throw OrbisError.notPaired
    case 403:
      throw OrbisError.refused
    case 409:
      let message = (try? Self.decoder.decode(ServerMessage.self, from: data))?.message
      if message == "This set is already in your library." {
        throw OrbisError.duplicate
      }
      throw OrbisError.server(status: 409, message: message ?? "")
    default:
      let message = (try? Self.decoder.decode(ServerMessage.self, from: data))?.message
      throw OrbisError.server(status: http.statusCode, message: message ?? "")
    }
  }
}

private struct ServerMessage: Decodable {
  let message: String
}
