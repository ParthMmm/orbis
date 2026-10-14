import Foundation
import OrbisDesign

/// A failure the user can act on. Each case carries the sentence the app shows, so the
/// recovery action is decided in one place rather than in every view.
enum OrbisError: Error, Equatable {
  case unreachable
  case notSignedIn
  case duplicate
  /// The view that started the request went away before it finished. Not a failure, and never
  /// shown to anyone, because the screen that replaces it loads on its own.
  case cancelled
  case server(status: Int, message: String)
  case malformed
  /// A web server answered instead of Orbis, such as a proxy's error page.
  case notOrbis
  /// The device refused to hold the key, so nothing was saved and nothing was changed.
  case storageRefused

  var message: String {
    switch self {
    case .unreachable:
      "Cannot reach your library. Check your internet connection and try again."
    case .notSignedIn:
      "This device is not signed in to your library. Sign out in Settings and sign in again."
    case .duplicate:
      "That set is already in your library."
    case .cancelled:
      "The request was interrupted."
    case .server(let status, let message):
      "The service reported \(status). \(message)"
    case .malformed:
      "The service sent a response this app does not understand. Update the app."
    case .notOrbis:
      "Something other than Orbis answered. A web page came back instead."
    case .storageRefused:
      "This device would not save the key, so nothing was changed. Try again."
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
    case .notSignedIn:
      failure = OrbisFailure(
        title: "This device is not signed in",
        message: message,
        symbol: "key.slash",
        isRetryable: false
      )
    case .malformed:
      failure = OrbisFailure(
        title: "Orbis sent an answer this app cannot read",
        message: message,
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
        title: "A web page answered, not Orbis",
        message: message,
        symbol: "globe",
        isRetryable: false
      )
    case .storageRefused:
      failure = OrbisFailure(
        title: "This device could not save the key",
        message: message,
        symbol: "key.slash",
        isRetryable: true
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

extension OrbisFailure {
  /// What a sign-in or Settings request failed with. The service explains a refusal, such as a
  /// wrong Group Passcode, a taken username, or an expired code, in a sentence meant for the
  /// person, so that sentence is shown as it came.
  static func explaining(_ error: any Error, at address: URL) -> OrbisFailure {
    let known = (error as? OrbisError) ?? .unreachable
    guard case .server(let status, let message) = known, (400..<500).contains(status),
      !message.isEmpty
    else { return known.failure(at: address) }
    return OrbisFailure(
      title: "Orbis could not do that", message: message, symbol: "hand.raised",
      isRetryable: status == 429, address: address.absoluteString)
  }
}

/// The Orbis service this app is built for (ADR 0020). The address is not a secret and is not
/// stored: a fresh install asks only for a sign-in.
enum OrbisService {
  static let address = URL(string: "https://orbis.p11a.xyz/api")!

  /// The address this launch talks to. A Debug journey points it at the lane's service with
  /// `-orbisServiceAddress <address>`, and a Debug Mac build at the service its development
  /// token belongs to; every other build uses the built-in one.
  static func address(for arguments: [String]) -> URL {
    #if DEBUG
      if let flag = arguments.firstIndex(of: "-orbisServiceAddress"),
        arguments.indices.contains(flag + 1),
        let url = URL(string: arguments[flag + 1]), OrbisClient.accepts(url)
      {
        return url
      }
      if let development = ClientSettings.developmentConfiguration,
        let url = URL(string: development.address), OrbisClient.accepts(url)
      {
        return url
      }
    #endif
    return address
  }
}

/// The signed-in Person, as `/me` answers.
struct Me: Codable, Equatable, Sendable {
  let autoDownload: Bool
  let host: Bool
  let id: String
  let social: Bool
  let username: String
}

/// A change to the signed-in Person. Absent fields are left as they are.
struct MeUpdate: Encodable {
  var autoDownload: Bool?
  var social: Bool?
  var username: String?
}

struct GroupPerson: Decodable, Equatable, Identifiable, Sendable {
  let id: String
  let username: String
}

/// A one-time code another device types to sign in as the same Person (ADR 0020).
struct SignInCode: Decodable, Equatable, Sendable {
  let code: String
  let expiresAt: String

  static let length = 8

  /// `ABCDEFGH` as `ABCD-EFGH`, which is easier to read aloud and type.
  var formatted: String {
    code.count == Self.length ? "\(code.prefix(4))-\(code.suffix(4))" : code
  }

  /// What a person typed, as the service compares it: `abcd efgh` and `ABCD-EFGH` are the
  /// same code.
  static func normalized(_ typed: String) -> String {
    typed.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
  }
}

private struct SignedIn: Decodable {
  let key: String
}

private struct GroupPasscode: Codable {
  let passcode: String?

  // Synthesized encoding drops nil; the service needs an explicit null to close joining.
  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(passcode, forKey: .passcode)
  }
}

private struct GroupPeople: Decodable {
  let people: [GroupPerson]
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

  /// An address is accepted only when it would carry the key safely: TLS, or the
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

  func me() async throws -> Me {
    let response = try await send(path: "me", method: "GET", body: nil)
    return try Self.decode(Me.self, from: response)
  }

  func updateMe(_ update: MeUpdate) async throws -> Me {
    let body = try Self.encoder.encode(update)
    let response = try await send(path: "me", method: "PATCH", body: body)
    return try Self.decode(Me.self, from: response)
  }

  // MARK: - Signing in (ADR 0020)

  /// Joins the Group as a new Person with the Group Passcode. Needs no key: a signed-out client
  /// calls it, and the answer is this device's key.
  func join(username: String, passcode: String, label: String) async throws -> String {
    let body = try Self.encoder.encode([
      "label": label, "passcode": passcode, "username": username,
    ])
    let response = try await send(path: "sign-in/join", method: "POST", body: body)
    return try Self.decode(SignedIn.self, from: response).key
  }

  /// Signs in as the Person who showed `code` on another device. Needs no key.
  func redeem(code: String, label: String) async throws -> String {
    let body = try Self.encoder.encode(["code": code, "label": label])
    let response = try await send(path: "sign-in/code", method: "POST", body: body)
    return try Self.decode(SignedIn.self, from: response).key
  }

  /// A code another device types to sign in as this Person.
  func signInCode() async throws -> SignInCode {
    let response = try await send(path: "me/sign-in-codes", method: "POST", body: nil)
    return try Self.decode(SignInCode.self, from: response)
  }

  // MARK: - The Host's controls

  /// A code that signs a device in as `personId`, which is how a friend who lost every device
  /// gets back in.
  func signInCode(for personId: String) async throws -> SignInCode {
    let response = try await send(
      path: "admin/people/\(personId)/sign-in-codes", method: "POST", body: nil)
    return try Self.decode(SignInCode.self, from: response)
  }

  /// The Group Passcode, or nil while joining is closed.
  func passcode() async throws -> String? {
    let response = try await send(path: "admin/passcode", method: "GET", body: nil)
    return try Self.decode(GroupPasscode.self, from: response).passcode
  }

  /// Sets the Group Passcode. Nil closes joining.
  func setPasscode(_ passcode: String?) async throws -> String? {
    let body = try Self.encoder.encode(GroupPasscode(passcode: passcode))
    let response = try await send(path: "admin/passcode", method: "PUT", body: body)
    return try Self.decode(GroupPasscode.self, from: response).passcode
  }

  func people() async throws -> [GroupPerson] {
    let response = try await send(path: "admin/people", method: "GET", body: nil)
    return try Self.decode(GroupPeople.self, from: response).people
  }

  func removePerson(_ id: String) async throws {
    _ = try await send(path: "admin/people/\(id)", method: "DELETE", body: nil)
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

  func tracklist(_ id: String) async throws -> Tracklist {
    let response = try await send(path: "sets/\(id)/tracklist", method: "GET", body: nil)
    return try Self.decode(Tracklist.self, from: response)
  }

  func retryTracklist(_ id: String) async throws -> Tracklist {
    let response = try await send(path: "sets/\(id)/tracklist/retry", method: "POST", body: nil)
    return try Self.decode(Tracklist.self, from: response)
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

  // MARK: - The Listening Queue

  /// The one Listening Queue, in play order.
  func listeningQueue() async throws -> ListeningQueue {
    let response = try await send(path: "queue", method: "GET", body: nil)
    return try decodedQueue(response)
  }

  /// Makes a Set the active one, which is what playing it does. The Set keeps its place when it
  /// is already queued, and takes the listening position when it is not.
  func playSet(_ id: String) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(SetIdRequest(setId: id))
    let response = try await send(path: "queue/active", method: "PUT", body: body)
    return try decodedQueue(response)
  }

  func queueSet(_ id: String, placement: QueuePlacement) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(
      QueueEntryRequest(placement: placement.rawValue, setId: id))
    let response = try await send(path: "queue/entries", method: "POST", body: body)
    return try decodedQueue(response)
  }

  /// Replaces the queue with a Playlist's playable members, in Playlist order.
  func playPlaylist(_ playlistId: String) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(PlaylistQueueRequest(playlistId: playlistId))
    let response = try await send(path: "queue/playlist", method: "PUT", body: body)
    return try decodedQueue(response)
  }

  /// Reports that the active Set reached its natural end. The service removes it, resets its
  /// Playback Position, and starts the next entry; a repeat of the same signal does nothing.
  func reportCompletion(_ id: String) async throws -> ListeningQueue {
    let body = try Self.encoder.encode(SetIdRequest(setId: id))
    let response = try await send(path: "queue/completion", method: "POST", body: body)
    return try decodedQueue(response)
  }

  /// Reports where playback has reached. The answer is the Set, so the stored position comes
  /// back rather than being assumed.
  func reportPosition(_ id: String, seconds: Int) async throws -> SavedSet {
    let body = try Self.encoder.encode(PlaybackPositionRequest(seconds: seconds))
    let response = try await send(path: "sets/\(id)/position", method: "PUT", body: body)
    return try decodedSet(response)
  }

  private func decodedSet(_ response: Data) throws -> SavedSet {
    try Self.decode(SavedSet.self, from: response)
  }

  private func decodedQueue(_ response: Data) throws -> ListeningQueue {
    try Self.decode(QueueResponse.self, from: response).queue
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
    // Resolving against the address would drop its last path segment, so an address such as
    // the Funnel address with `/api` would lose `/api`. Join the strings instead.
    let root = address.absoluteString
    // Only an id the service never sends could make this fail.
    guard let url = URL(string: root.hasSuffix("/") ? root + path : root + "/" + path) else {
      throw OrbisError.malformed
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
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
      throw OrbisError.notSignedIn
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
