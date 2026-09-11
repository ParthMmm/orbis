import Foundation

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
        case let .server(status, message):
            "The service reported \(status). \(message)"
        case .malformed:
            "The service sent a response this app does not understand. Update the app."
        case .badAddress:
            "Enter the full service address, including https://."
        }
    }
}

/// A failure as a screen needs to show it: a heading that says what went wrong, the sentence
/// underneath, and whether trying again could change the answer.
///
/// Every library failure used to wear the same heading, so a person whose service was older than
/// their app was told their network was down. A Try again button that cannot change the answer is
/// its own kind of lie, which is why retryability is part of the failure rather than of the view.
struct OrbisFailure: Equatable {
    let title: String
    let message: String
    let symbol: String
    let isRetryable: Bool
    /// Where the app was looking when this happened, which is the first thing worth checking and
    /// the first thing a person forgets to mention.
    var address: String?
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
                message: "\(message) Check that the address points at Orbis itself, and that the service is not older or newer than this app.",
                symbol: "doc.questionmark",
                isRetryable: false
            )
        case let .server(status, _):
            failure = OrbisFailure(
                title: "Your library reported an error",
                message: message,
                symbol: "exclamationmark.triangle",
                isRetryable: status >= 500
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
        guard let url = URL(string: trimmed), url.scheme != nil, url.host != nil else {
            throw OrbisError.badAddress
        }
        return url
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
        #if DEBUG
            // A body that is not JSON means something other than Orbis answered, which looks the
            // same as a version skew from inside the app. Print the address and what arrived, so
            // the next time this happens it is a fact in the log rather than a hunt.
            let head = data.prefix(160)
            if head.first != UInt8(ascii: "{"), head.first != UInt8(ascii: "[") {
                let line =
                    "Orbis read a non-JSON body from \(request.url?.absoluteString ?? "?"): \(String(decoding: head, as: UTF8.self))\n"
                FileHandle.standardError.write(Data(line.utf8))
            }
        #endif
        switch http.statusCode {
        case 200 ..< 300:
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
