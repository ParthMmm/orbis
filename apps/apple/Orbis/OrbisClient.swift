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

  func health() async throws -> String {
    let response = try await send(path: "health", method: "GET", body: nil)
    guard let decoded = try? JSONDecoder().decode(HealthResponse.self, from: response) else {
      throw OrbisError.malformed
    }
    return decoded.status
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
    guard let decoded = try? JSONDecoder().decode(LibraryResponse.self, from: response) else {
      throw OrbisError.malformed
    }
    return decoded.sets
  }

  func playlists() async throws -> [Playlist] {
    let response = try await send(path: "playlists", method: "GET", body: nil)
    guard let decoded = try? JSONDecoder().decode(PlaylistsResponse.self, from: response)
    else {
      throw OrbisError.malformed
    }
    return decoded.playlists
  }

  func save(url: String, tags: [String] = []) async throws -> SavedSet {
    let body = try JSONEncoder().encode(SaveSetRequest(tags: tags, url: url))
    let response = try await send(path: "sets", method: "POST", body: body)
    return try decodedSet(response)
  }

  func updateTitle(_ id: String, title: String) async throws -> SavedSet {
    let body = try JSONEncoder().encode(SetTitleRequest(title: title))
    let response = try await send(path: "sets/\(id)/title", method: "PATCH", body: body)
    return try decodedSet(response)
  }

  func updateTags(_ id: String, tags: [String]) async throws -> SavedSet {
    let body = try JSONEncoder().encode(SetTagsRequest(tags: tags))
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
    let body = try JSONEncoder().encode(SetPlaylistsRequest(playlistIds: playlistIds))
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
    guard let decoded = try? JSONDecoder().decode(AudioState.self, from: response) else {
      throw OrbisError.malformed
    }
    return decoded
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
    guard let decoded = try? JSONDecoder().decode(SavedSet.self, from: response) else {
      throw OrbisError.malformed
    }
    return decoded
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
        // standard error because stdout is buffered and a killed run loses it.
        let line = "Orbis transport failure \(request.url?.absoluteString ?? "?"): \(error)\n"
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
        let line =
          "Orbis read a web page from \(request.url?.absoluteString ?? "?"): \(String(decoding: head, as: UTF8.self))\n"
        FileHandle.standardError.write(Data(line.utf8))
      #endif
      throw OrbisError.notOrbis
    }
    #if DEBUG
      // A body that is not JSON and not a web page is usually a version skew: something
      // answered in a shape this build does not know. Print it rather than guess.
      if head.first != UInt8(ascii: "{"), head.first != UInt8(ascii: "[") {
        let line =
          "Orbis read a non-JSON body from \(request.url?.absoluteString ?? "?"): \(String(decoding: head, as: UTF8.self))\n"
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
      throw OrbisError.duplicate
    default:
      let message = (try? JSONDecoder().decode(ServerMessage.self, from: data))?.message
      throw OrbisError.server(status: http.statusCode, message: message ?? "")
    }
  }
}

private struct ServerMessage: Decodable {
  let message: String
}
