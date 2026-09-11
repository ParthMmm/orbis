import Foundation
import XCTest

@testable import Orbis

final class OrbisClientTests: XCTestCase {
    func testAddressRequiresASchemeAndHost() throws {
        let url = try OrbisClient.address(from: "  https://vanta.example.ts.net  ")
        XCTAssertEqual(url.absoluteString, "https://vanta.example.ts.net")

        for input in ["", "vanta.example.ts.net", "not a url"] {
            XCTAssertThrowsError(try OrbisClient.address(from: input), input) { error in
                XCTAssertEqual(error as? OrbisError, .badAddress)
            }
        }
    }

    func testHealthDecodesTheStatus() async throws {
        let session = StubProtocol.session(status: 200, body: #"{"status":"ok"}"#)
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let status = try await client.health()
        XCTAssertEqual(status, "ok")
        XCTAssertEqual(StubProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer token")
    }

    func testLibraryDecodesSetsAndSendsTheSearchQuery() async throws {
        let body = """
        {"sets":[{"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk",
        "title":"Night session","source":"youtube","tags":["techno"],"createdAt":"2026-01-01T00:00:00.000Z",
        "creator":null,"artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
        "downloadState":"none","playlistIds":[],"playbackPositionSeconds":1800,"listenCount":2,"finishCount":0,
        "lastListenedAt":null}]}
        """
        let session = StubProtocol.session(status: 200, body: body)
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let sets = try await client.library(query: "night mix")
        XCTAssertEqual(sets.count, 1)
        XCTAssertEqual(sets[0].title, "Night session")
        XCTAssertEqual(sets[0].durationSeconds, 5400)
        XCTAssertEqual(sets[0].playbackPositionSeconds, 1800)
        XCTAssertTrue(StubProtocol.lastRequest?.url?.query()?.contains("night") == true)
    }

    func testFailuresMapToActionableCases() async {
        let cases: [(Int, String, OrbisError)] = [
            (401, #"{"message":"nope"}"#, .notPaired),
            (403, #"{"message":"nope"}"#, .refused),
            (409, #"{"message":"This set is already in your library."}"#, .duplicate),
            (500, #"{"message":"Broken."}"#, .server(status: 500, message: "Broken.")),
            (200, "not json", .malformed),
        ]
        for (status, body, expected) in cases {
            let client = OrbisClient(
                address: URL(string: "https://vanta.example.ts.net")!,
                token: "token",
                session: StubProtocol.session(status: status, body: body)
            )
            do {
                _ = try await client.health()
                XCTFail("expected \(expected) for status \(status)")
            } catch let error as OrbisError {
                XCTAssertEqual(error, expected)
                XCTAssertFalse(error.message.isEmpty)
            } catch {
                XCTFail("unexpected \(error)")
            }
        }
    }

    func testSavePostsTheLinkAndDecodesTheSavedSet() async throws {
        let body = """
        {"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk",
        "title":"Night session","source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z",
        "creator":"Ada Lovelace","artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
        "downloadState":"none","playlistIds":[],"playbackPositionSeconds":0,"listenCount":0,"finishCount":0,
        "lastListenedAt":null}
        """
        let session = StubProtocol.session(status: 201, body: body)
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let saved = try await client.save(url: "https://youtu.be/abcdefghijk")
        XCTAssertEqual(saved.title, "Night session")
        XCTAssertEqual(saved.creator, "Ada Lovelace")
        XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets")
        let sent = try XCTUnwrap(StubProtocol.lastBody)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: sent) as? [String: Any]
        )
        XCTAssertEqual(json["url"] as? String, "https://youtu.be/abcdefghijk")
        XCTAssertEqual(json["tags"] as? [String], [])
    }

    func testTitleEditPatchesTheSetAndDecodesWhatCameBack() async throws {
        let session = StubProtocol.session(
            status: 200, body: Self.savedSet(title: "Renamed by hand", tags: []))
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let updated = try await client.updateTitle("42", title: "Renamed by hand")
        XCTAssertEqual(updated.title, "Renamed by hand")
        XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PATCH")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/42/title")
        let sent = try XCTUnwrap(StubProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(json["title"] as? String, "Renamed by hand")
    }

    func testTagEditPatchesTheSetAndDecodesWhatCameBack() async throws {
        let session = StubProtocol.session(
            status: 200, body: Self.savedSet(title: "Night session", tags: ["techno", "live"]))
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let updated = try await client.updateTags("42", tags: ["techno", "live"])
        XCTAssertEqual(updated.tags, ["techno", "live"])
        XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PATCH")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/42/tags")
        let sent = try XCTUnwrap(StubProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(json["tags"] as? [String], ["techno", "live"])
    }

    /// A service older than this field must not make the library unreadable, which is exactly
    /// what happened when the field arrived.
    func testASetFromAnOlderServiceStillDecodes() async throws {
        let older = """
        {"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk",
        "title":"Night session","source":"youtube","tags":["techno"],"createdAt":"2026-01-01T00:00:00.000Z",
        "creator":null,"artworkUrl":null,"durationSeconds":null,"metadataState":"enriched",
        "downloadState":"none","playbackPositionSeconds":0,"listenCount":0,"finishCount":0,
        "lastListenedAt":null}
        """
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: StubProtocol.session(status: 200, body: #"{"sets":["# + older + "]}")) 
        let sets = try await client.library()
        XCTAssertEqual(sets.count, 1)
        XCTAssertEqual(sets[0].title, "Night session")
        XCTAssertEqual(sets[0].playlistIds, [])
    }

    func testPlaylistMembershipIsStatedInFullOnTheSet() async throws {
        let session = StubProtocol.session(
            status: 200, body: Self.savedSet(title: "Night session", tags: []))
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        _ = try await client.updatePlaylists("42", playlistIds: ["p1", "p2"])
        XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/42/playlists")
        let sent = try XCTUnwrap(StubProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(json["playlistIds"] as? [String], ["p1", "p2"])
    }

    func testDeleteAsksTheServiceToRemoveTheSet() async throws {
        let session = StubProtocol.session(
            status: 200, body: Self.savedSet(title: "Night session", tags: []))
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let removed = try await client.deleteSet("42")
        XCTAssertEqual(removed.id, "1")
        XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "DELETE")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/42")
        XCTAssertNil(StubProtocol.lastBody)
    }

    func testMetadataRetryAsksAgainForTheName() async throws {
        let session = StubProtocol.session(
            status: 200, body: Self.savedSet(title: "Named at last", tags: []))
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let updated = try await client.retryMetadata("42")
        XCTAssertEqual(updated.title, "Named at last")
        XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/42/metadata")
        XCTAssertNil(StubProtocol.lastBody)
    }

    static func savedSet(title: String, tags: [String]) -> String {
        """
        {"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk",
        "title":"\(title)","source":"youtube","tags":\(encode(tags)),"createdAt":"2026-01-01T00:00:00.000Z",
        "creator":"Ada Lovelace","artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
        "downloadState":"none","playlistIds":[],"playbackPositionSeconds":0,"listenCount":0,"finishCount":0,
        "lastListenedAt":null}
        """
    }

    private static func encode(_ tags: [String]) -> String {
        let data = try? JSONEncoder().encode(tags)
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }

    func testPlaylistsDecodeWithTheirCounts() async throws {
        let body = """
        {"playlists":[{"id":"1","name":"Long drives","createdAt":"2026-01-01T00:00:00.000Z","setCount":4},
        {"id":"2","name":"Closing sets","createdAt":"2026-01-01T00:00:00.000Z","setCount":0}]}
        """
        let session = StubProtocol.session(status: 200, body: body)
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        let playlists = try await client.playlists()
        XCTAssertEqual(playlists.map(\.name), ["Long drives", "Closing sets"])
        XCTAssertEqual(playlists.map(\.setCount), [4, 0])
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/playlists")
    }

    func testLibraryAsksForOnePlaylistByItsIdentifier() async throws {
        let session = StubProtocol.session(status: 200, body: #"{"sets":[]}"#)
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: session
        )
        _ = try await client.library(playlistId: "abc")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.query(), "playlistId=abc")
    }

    func testACancelledRequestIsNotReportedAsUnreachable() async {
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: StubProtocol.session(failure: URLError(.cancelled))
        )
        do {
            _ = try await client.health()
            XCTFail("expected a cancellation")
        } catch let error as OrbisError {
            XCTAssertEqual(error, .cancelled)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testTransportFailureIsUnreachable() async {
        let client = OrbisClient(
            address: URL(string: "https://vanta.example.ts.net")!,
            token: "token",
            session: StubProtocol.session(failure: URLError(.cannotConnectToHost))
        )
        do {
            _ = try await client.library()
            XCTFail("expected unreachable")
        } catch let error as OrbisError {
            XCTAssertEqual(error, .unreachable)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

/// Answers every request from static configuration so the client can be tested without a
/// server. Static rather than injected because `URLProtocol` is instantiated by the loading
/// system, so tests run one at a time.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = ""
    nonisolated(unsafe) static var failure: URLError?
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    static func session(status: Int, body: String) -> URLSession {
        Self.status = status
        Self.body = body
        Self.failure = nil
        Self.lastRequest = nil
        Self.lastBody = nil
        return makeSession()
    }

    static func session(failure: URLError) -> URLSession {
        Self.failure = failure
        Self.lastRequest = nil
        Self.lastBody = nil
        return makeSession()
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        StubProtocol.lastRequest = request
        StubProtocol.lastBody = Self.readBody(request)
        if let failure = StubProtocol.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: StubProtocol.status,
            httpVersion: nil,
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(StubProtocol.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// URLSession hands URLProtocol a stream rather than `httpBody`, so a test asserting on a
    /// request body would otherwise always read nil.
    private static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 {
                break
            }
            data.append(buffer, count: read)
        }
        return data.isEmpty ? nil : data
    }
}
