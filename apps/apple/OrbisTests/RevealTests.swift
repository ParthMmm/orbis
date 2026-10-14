import Synchronization
import XCTest

@testable import Orbis

@MainActor
final class RevealTests: XCTestCase {
  private func set(
    id: String = "1", title: String = "Night session", tags: [String] = [],
    metadataState: String = "enriched"
  ) -> SavedSet {
    SavedSet(
      id: id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: title,
      source: .youtube,
      tags: tags,
      createdAt: "2026-01-01T00:00:00.000Z",
      releasedAt: nil,
      creator: "Ada Lovelace",
      artworkUrl: nil,
      artworkLargeUrl: nil,
      durationSeconds: 5400,
      metadataState: metadataState,
      downloadState: "none",
      playlistIds: [],
      playbackPositionSeconds: 0,
      listenCount: 0,
      finishCount: 0,
      lastListenedAt: nil
    )
  }

  private func model(reveal: AppModel.Reveal?) -> AppModel {
    let model = AppModel(settings: MemoryClientSettings())
    model.reveal = reveal
    return model
  }

  func testTheLinkFieldTellsADuplicateFromAnAddressOrbisDoesNotKnow() {
    XCTAssertEqual(
      SetPresentation.linkState(isFiling: false, failure: .duplicate),
      .duplicate(message: OrbisError.duplicate.message)
    )
    let refusal = OrbisError.server(status: 400, message: "Orbis does not know that address.")
    XCTAssertEqual(
      SetPresentation.linkState(isFiling: false, failure: refusal),
      .invalid(message: refusal.message)
    )
  }

  func testARevealWithNothingChangedHasNothingToSend() {
    let open = AppModel.Reveal(set: set(), title: "Night session", tags: [])
    XCTAssertFalse(open.hasChanges)
    XCTAssertTrue(open.titleUntouched)

    XCTAssertTrue(AppModel.Reveal(set: set(), title: "Renamed", tags: []).hasChanges)
    XCTAssertTrue(AppModel.Reveal(set: set(), title: "Night session", tags: ["techno"]).hasChanges)
  }

  func testAnEmptyTitleLeavesTheNameThatArrivedAlone() {
    let open = AppModel.Reveal(set: set(title: "YouTube video"), title: "", tags: [])
    XCTAssertNil(open.renamedTitle)
    XCTAssertFalse(open.hasChanges)
    XCTAssertTrue(open.titleUntouched)
  }

  func testALongTitleIsCutToWhatTheServiceKeeps() {
    let open = AppModel.Reveal(
      set: set(), title: String(repeating: "a", count: 300), tags: [])
    XCTAssertEqual(open.renamedTitle?.count, 200)
  }

  func testFilingIntoThePlaylistBeingViewedKeepsTheListTruthful() async {
    let saveBody = OrbisClientTests.savedSet(title: "Fresh paste", tags: [])
    let belonging = saveBody.replacingOccurrences(
      of: "\"playlistIds\":[]", with: "\"playlistIds\":[\"viewed\"]")
    for (body, expected) in [(belonging, ["Fresh paste", "First"]), (saveBody, ["First"])] {
      let model = AppModel(
        client: OrbisClient(
          address: URL(string: "https://vanta.example.ts.net")!,
          token: "token",
          session: StubProtocol.session { request in
            request.url?.path() == "/sets" && request.httpMethod == "POST"
              ? (201, body) : (500, "{}")
          }
        ), settings: MemoryClientSettings())
      model.library = .loaded([self.set(id: "2", title: "First")])
      model.selectedPlaylistId = "viewed"
      model.linkToFile = "https://youtu.be/abcdefghijk"

      await model.fileLink()

      guard case .loaded(let sets) = model.library else {
        return XCTFail("expected a loaded library")
      }
      XCTAssertEqual(
        sets.map(\.title), expected,
        "a filed Set \(belongsCaseName(expected)) the playlist being viewed")
      XCTAssertEqual(model.linkToFile, "", "a filed link leaves the field")
    }
  }

  private func belongsCaseName(_ expected: [String]) -> String {
    expected.count > 1 ? "joins" : "stays out of"
  }

  private func retryModel(
    set: SavedSet,
    title: String,
    tags: [String],
    body: String,
    hold: TimeInterval = 0.3
  ) -> AppModel {
    retryModel(
      set: set, title: title, tags: tags,
      responder: { _ in (200, body) }, holding: { _ in hold })
  }

  private func retryModel(
    set: SavedSet,
    title: String,
    tags: [String],
    responder: @escaping @Sendable (URLRequest) -> (Int, String),
    holding: @escaping @Sendable (URLRequest) -> TimeInterval = { _ in 0.3 }
  ) -> AppModel {
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session(responder: responder, holding: holding)
      ), settings: MemoryClientSettings())
    model.reveal = AppModel.Reveal(set: set, title: title, tags: tags)
    return model
  }

  private func waitForTheRetryRequest() async throws {
    var waited = 0
    while !(StubProtocol.lastRequest?.url?.path().hasSuffix("/metadata") ?? false), waited < 200 {
      try await Task.sleep(for: .milliseconds(10))
      waited += 1
    }
    let request = try XCTUnwrap(
      StubProtocol.lastRequest, "the held metadata request must have started")
    XCTAssertTrue(
      request.url?.path().hasSuffix("/metadata") == true,
      "the retry must be the request the stub is holding")
  }

  private func startRetryAndEdit(
    _ model: AppModel,
    file: StaticString = #filePath,
    line: UInt = #line,
    edit: (AppModel) -> Void
  ) async -> Task<Void, Never>? {
    let started = Task { await model.retryMetadata() }
    do {
      try await waitForTheRetryRequest()
    } catch {
      await started.value
      XCTFail("the metadata request never reached the stub", file: file, line: line)
      return nil
    }
    guard model.isSavingReveal else {
      await started.value
      XCTFail("the held response arrived before the draft was edited", file: file, line: line)
      return nil
    }
    edit(model)
    return started
  }

  func testTitleAndTagsEditedDuringARetryBothSurviveIt() async {
    let model = retryModel(
      set: set(metadataState: "failed"), title: "Night session", tags: [],
      body: OrbisClientTests.savedSet(title: "Server name", tags: []))

    let started = await startRetryAndEdit(model) {
      $0.reveal?.title = "Renamed while waiting"
      $0.reveal?.tags = ["techno", "morning"]
    }
    guard let started else { return }
    await started.value

    XCTAssertEqual(model.reveal?.title, "Renamed while waiting")
    XCTAssertEqual(model.reveal?.tags, ["techno", "morning"])
  }

  func testAnUntouchedTitleAdoptsTheNameTheRetryBrought() async {
    let open = set(title: "YouTube video", metadataState: "failed")
    let model = retryModel(
      set: open, title: "", tags: [],
      body: OrbisClientTests.savedSet(title: "Server name", tags: []))
    model.library = .loaded([open])

    let started = await startRetryAndEdit(model) { _ in }
    guard let started else { return }
    await started.value

    XCTAssertEqual(model.reveal?.title, "Server name")
    XCTAssertEqual(model.reveal?.set.title, "Server name")
    XCTAssertEqual(model.savedSet("1")?.title, "Server name", "the Library takes the new metadata")
    XCTAssertNil(model.revealFailure)
    XCTAssertFalse(model.isSavingReveal)
  }

  func testATitleTypedBeforeTheRetryStaysThePersons() async {
    let open = set(title: "YouTube video", metadataState: "failed")
    let model = retryModel(
      set: open, title: "My own name", tags: [],
      body: OrbisClientTests.savedSet(title: "Server name", tags: []))
    model.library = .loaded([open])

    let started = await startRetryAndEdit(model) { _ in }
    guard let started else { return }
    await started.value

    XCTAssertEqual(model.reveal?.title, "My own name")
    XCTAssertEqual(model.reveal?.set.title, "Server name", "the saved baseline still advances")
    XCTAssertEqual(model.savedSet("1")?.title, "Server name")
  }

  func testADismissedRevealStaysDismissedWhenTheRetryLands() async {
    let model = retryModel(
      set: set(metadataState: "failed"), title: "", tags: [],
      body: OrbisClientTests.savedSet(title: "Server name", tags: []))

    let started = await startRetryAndEdit(model) { $0.closeReveal() }
    guard let started else { return }
    await started.value

    XCTAssertNil(model.reveal, "a late answer never reopens a screen the person left")
    XCTAssertFalse(model.isSavingReveal)
  }

  func testARetryCannotOverwriteADifferentSetOpenedMeanwhile() async {
    let other = set(id: "2", title: "Other set", tags: ["morning"])
    let open = set(title: "YouTube video", metadataState: "failed")
    let model = retryModel(
      set: open, title: "", tags: [],
      body: OrbisClientTests.savedSet(title: "Server name", tags: []))
    model.library = .loaded([open, other])

    let started = await startRetryAndEdit(model) {
      $0.reveal = AppModel.Reveal(set: other, title: "Edited other", tags: ["night"])
    }
    guard let started else { return }
    await started.value

    XCTAssertEqual(model.reveal?.set.id, "2")
    XCTAssertEqual(model.reveal?.title, "Edited other")
    XCTAssertEqual(model.reveal?.tags, ["night"])
    XCTAssertEqual(
      model.savedSet("1")?.title, "YouTube video",
      "the abandoned request must not publish over the Library either")
  }

  func testASecondRetryWhileOneIsOutSendsNothing() async {
    let requests = RequestCounter()
    let model = retryModel(
      set: set(metadataState: "failed"), title: "", tags: [],
      responder: { _ in
        requests.record()
        return (200, OrbisClientTests.savedSet(title: "Server name", tags: []))
      })

    let started = await startRetryAndEdit(model) { _ in }
    guard let started else { return }
    await model.retryMetadata()
    XCTAssertEqual(requests.count, 1, "the second press must not send a request")
    await started.value

    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(model.reveal?.title, "Server name")
    XCTAssertFalse(model.isSavingReveal)
  }

  func testAProviderFailureStillKeepsTheDraftAndRefreshesTheSavedSet() async {
    let placeholder =
      OrbisClientTests.savedSet(title: "YouTube video", tags: [])
      .replacingOccurrences(of: "\"metadataState\":\"enriched\"", with: "\"metadataState\":\"failed\"")
    let open = set(title: "YouTube video", metadataState: "failed")
    let model = retryModel(set: open, title: "My own name", tags: [], body: placeholder)
    model.library = .loaded([open])

    let started = await startRetryAndEdit(model) { $0.reveal?.title = "Renamed while waiting" }
    guard let started else { return }
    await started.value

    XCTAssertEqual(model.reveal?.title, "Renamed while waiting")
    XCTAssertEqual(model.reveal?.set.metadataState, "failed")
    XCTAssertEqual(model.savedSet("1")?.metadataState, "failed")
    XCTAssertNil(model.revealFailure, "a provider failure comes back as a Set, not as an error")
    XCTAssertFalse(model.isSavingReveal)
  }

  func testARefusedRetryKeepsTheDraftAndTheSavedSetItStartedWith() async {
    let open = set(title: "YouTube video", metadataState: "failed")
    let model = retryModel(
      set: open, title: "My own name", tags: ["techno"],
      responder: { _ in (500, #"{"message":"Broken."}"#) })
    model.library = .loaded([open])

    let started = await startRetryAndEdit(model) { $0.reveal?.title = "Renamed while waiting" }
    guard let started else { return }
    await started.value

    XCTAssertEqual(model.reveal?.title, "Renamed while waiting")
    XCTAssertEqual(model.reveal?.tags, ["techno"])
    XCTAssertEqual(model.reveal?.set.title, "YouTube video", "a refused retry changes no baseline")
    XCTAssertEqual(model.savedSet("1")?.title, "YouTube video")
    XCTAssertEqual(model.revealFailure?.message, OrbisError.server(status: 500, message: "Broken.").message)
    XCTAssertFalse(model.isSavingReveal)
  }
}

private final class RequestCounter: Sendable {
  private let hits = Mutex(0)

  func record() { hits.withLock { $0 += 1 } }

  var count: Int { hits.withLock { $0 } }
}
