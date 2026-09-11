import Foundation

/// A failure the user can act on. Each case carries the sentence the app shows, so the
/// recovery action is decided in one place rather than in every view.
enum OrbisError: Error, Equatable {
    case unreachable
    case notPaired
    case refused
    case duplicate
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
        case let .server(status, message):
            "The service reported \(status). \(message)"
        case .malformed:
            "The service sent a response this app does not understand. Update the app."
        case .badAddress:
            "Enter the full service address, including https://."
        }
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

    func library(query: String = "") async throws -> [SavedSet] {
        var path = "sets"
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            var components = URLComponents()
            components.queryItems = [URLQueryItem(name: "q", value: trimmed)]
            path += "?\(components.percentEncodedQuery ?? "")"
        }
        let response = try await send(path: path, method: "GET", body: nil)
        guard let decoded = try? JSONDecoder().decode(LibraryResponse.self, from: response) else {
            throw OrbisError.malformed
        }
        return decoded.sets
    }

    func save(url: String, tags: [String] = []) async throws -> SavedSet {
        let body = try JSONEncoder().encode(SaveSetRequest(tags: tags, url: url))
        let response = try await send(path: "sets", method: "POST", body: body)
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
