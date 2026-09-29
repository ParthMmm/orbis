import Foundation
import XCTest

@testable import Orbis

final class ContractResponseTests: XCTestCase {
  private struct Samples: Decodable {
    struct Tags: Decodable { let tags: [String] }
    struct Person: Decodable {
      let id: String
      let username: String
    }

    let audioState: AudioState
    let health: HealthResponse
    let library: LibraryResponse
    let me: Person
    let playlist: Playlist
    let playlists: PlaylistsResponse
    let queue: QueueResponse
    let savedSet: SavedSet
    let tags: Tags
  }

  func testSwiftModelsDecodeServedContractResponses() throws {
    let file = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("Fixtures/contract-responses.json")
    let samples = try JSONDecoder().decode(Samples.self, from: Data(contentsOf: file))

    XCTAssertEqual(samples.library.sets.first?.id, samples.savedSet.id)
    XCTAssertEqual(samples.playlists.playlists.first?.id, samples.playlist.id)
    XCTAssertEqual(samples.audioState.state, "none")
    XCTAssertEqual(samples.queue.queue.entries.count, 0)
    XCTAssertEqual(samples.tags.tags, samples.savedSet.tags)
    XCTAssertEqual(samples.health.status, "ok")
    XCTAssertEqual(samples.me.id, "host")
  }
}
