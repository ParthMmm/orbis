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
        "downloadState":"none","playbackPositionSeconds":1800,"listenCount":2,"finishCount":0,
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
        "downloadState":"none","playbackPositionSeconds":0,"listenCount":0,"finishCount":0,
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
