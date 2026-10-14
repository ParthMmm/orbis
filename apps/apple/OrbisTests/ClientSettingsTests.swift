import Foundation
import XCTest

@testable import Orbis

@MainActor
final class ClientSettingsTests: XCTestCase {
  private func isolatedLiveSettings() -> (settings: LiveClientSettings, cleanup: () -> Void) {
    let keychain = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)", account: "device-token")
    return (LiveClientSettings(keychain: keychain, developmentToken: { nil }), { keychain.delete() })
  }

  func testSigningInAndOutChangeOnlyTheInjectedStore() async {
    let sentinel = MemoryClientSettings()
    XCTAssertTrue(sentinel.store(deviceToken: "synthetic-sentinel-token"))

    let settings = MemoryClientSettings()
    let model = AppModel(
      settings: settings,
      session: StubProtocol.session { request in
        request.url?.path().hasSuffix("/sign-in/code") == true
          ? (200, #"{"key":"synthetic-fresh-token","person":{"id":"p1","username":"ada"}}"#)
          : (500, "{}")
      })

    await model.signIn(.code("ABCD-EFGH"))

    XCTAssertNil(model.signInFailure)
    XCTAssertEqual(settings.deviceToken, "synthetic-fresh-token")
    XCTAssertEqual(
      sentinel.deviceToken, "synthetic-sentinel-token", "an independent store must stay untouched")

    model.signOut()

    XCTAssertNil(settings.deviceToken, "signing out must clear the store the model was given")
    XCTAssertEqual(sentinel.deviceToken, "synthetic-sentinel-token")
  }

  func testEveryTestProcessSelectsMemoryWithoutBuildingTheLiveStore() {
    var liveConstructions = 0
    let cases: [(environment: [String: String], isTestHost: Bool, why: String)] = [
      (["ORBIS_TEST_SETTINGS": "memory"], false, "an explicit memory mode"),
      ([:], true, "a recognized test host with no override"),
      (["ORBIS_TEST_SETTINGS": "something-else"], true, "a recognized test host with a bad override"),
    ]

    for testCase in cases {
      let settings = ClientSettings.makeForProcess(
        environment: testCase.environment,
        isTestHost: testCase.isTestHost
      ) {
        liveConstructions += 1
        return MemoryClientSettings()
      }
      XCTAssertTrue(
        settings is MemoryClientSettings, "\(testCase.why) must select the memory store")
    }

    XCTAssertEqual(
      liveConstructions, 0, "the live store must never be built for a test process")
  }

  func testAnOrdinaryDebugProcessBuildsTheLiveStoreOnce() {
    var liveConstructions = 0
    let settings = ClientSettings.makeForProcess(environment: [:], isTestHost: false) {
      liveConstructions += 1
      return self.isolatedLiveSettings().settings
    }

    XCTAssertEqual(
      liveConstructions, 1, "a process that is not a test must build the live store exactly once")
    XCTAssertTrue(settings is LiveClientSettings)
  }

  func testALiveStoreRoundTripsThroughAnIsolatedKeychain() {
    let (settings, cleanup) = isolatedLiveSettings()
    defer { cleanup() }

    XCTAssertNil(settings.configuredClient(address: OrbisService.address))

    XCTAssertTrue(settings.store(deviceToken: "synthetic-first-token"))
    XCTAssertEqual(settings.deviceToken, "synthetic-first-token")
    XCTAssertNotNil(settings.configuredClient(address: OrbisService.address))

    XCTAssertTrue(settings.store(deviceToken: "synthetic-second-token"))
    XCTAssertEqual(
      settings.deviceToken, "synthetic-second-token",
      "the replacement must not have lost the stored pairing")

    XCTAssertTrue(settings.store(deviceToken: nil))
    XCTAssertNil(settings.deviceToken)
    XCTAssertNil(settings.configuredClient(address: OrbisService.address))
  }

  func testClearingOneIsolatedNamespaceLeavesAnotherAlone() {
    let (first, cleanFirst) = isolatedLiveSettings()
    let (second, cleanSecond) = isolatedLiveSettings()
    defer {
      cleanFirst()
      cleanSecond()
    }

    XCTAssertTrue(first.store(deviceToken: "synthetic-first-token"))
    XCTAssertTrue(second.store(deviceToken: "synthetic-second-token"))

    XCTAssertTrue(first.store(deviceToken: nil))

    XCTAssertNil(first.deviceToken)
    XCTAssertEqual(second.deviceToken, "synthetic-second-token")
  }

  func testConfiguredClientNeedsAToken() {
    let settings = MemoryClientSettings()
    let address = URL(string: "https://vanta.example.ts.net/api")!
    XCTAssertNil(settings.configuredClient(address: address), "an empty store is signed out")

    XCTAssertTrue(settings.store(deviceToken: ""))
    XCTAssertNil(settings.configuredClient(address: address), "an empty token is signed out")

    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    XCTAssertEqual(settings.configuredClient(address: address)?.address, address)
  }

  func testTheServiceAddressArgumentAcceptsOnlyTLSOrLoopback() {
    for accepted in ["http://127.0.0.1:4310", "https://lane.example/api"] {
      XCTAssertEqual(
        OrbisService.address(for: ["-orbisServiceAddress", accepted]).absoluteString, accepted)
    }
    let refused = "http://lane.example"
    XCTAssertNotEqual(
      OrbisService.address(for: ["-orbisServiceAddress", refused]).absoluteString, refused)
  }

  func testTheResetLaunchArgumentClearsOnlyTheInjectedStore() {
    let settings = MemoryClientSettings()
    XCTAssertTrue(settings.store(deviceToken: "synthetic-stale-token"))

    AppModel.resetSettings(ifRequestedBy: [], in: settings)
    XCTAssertEqual(
      settings.deviceToken, "synthetic-stale-token",
      "without the reset argument the store must be left alone")

    AppModel.resetSettings(ifRequestedBy: ["-orbisResetSettings"], in: settings)
    XCTAssertNil(settings.deviceToken)
  }

  func testASuccessfulWriteReachesSecurityThroughTheAdapter() {
    let existing = FakeKeychainOperations(storedToken: "synthetic-old-token")
    let store = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)",
      account: "device-token",
      operations: existing
    )

    XCTAssertTrue(store.write("synthetic-new-token"))
    XCTAssertEqual(existing.callOrder, ["update"], "an item already held is replaced in place")
    XCTAssertEqual(existing.storedToken, "synthetic-new-token")
    XCTAssertEqual(store.read(), "synthetic-new-token")

    let absent = FakeKeychainOperations()
    absent.updateStatus = errSecItemNotFound
    let fresh = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)",
      account: "device-token",
      operations: absent
    )

    XCTAssertTrue(fresh.write("synthetic-first-token"))
    XCTAssertEqual(absent.callOrder, ["update", "add"], "an absent item is added once")
    XCTAssertEqual(absent.storedToken, "synthetic-first-token")
    XCTAssertEqual(fresh.read(), "synthetic-first-token")
  }

  /// The query names the item and the attributes carry the value. `SecItemUpdate` refuses an
  /// item class or a search property among the attributes it applies, so the store must hand
  /// the adapter two different dictionaries rather than one copied dictionary.
  func testTheUpdateQueryNamesTheItemAndTheAttributesCarryTheValue() {
    let operations = FakeKeychainOperations(storedToken: "synthetic-old-token")
    let store = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)",
      account: "device-token",
      operations: operations
    )

    XCTAssertTrue(store.write("synthetic-new-token"))

    guard let update = operations.updateCalls.first else {
      return XCTFail("a write must reach the adapter as an update")
    }
    XCTAssertEqual(operations.updateCalls.count, 1)
    XCTAssertEqual(
      update.queryKeys,
      [kSecClass as String, kSecAttrService as String, kSecAttrAccount as String],
      "the query must name the item the write replaces")
    XCTAssertTrue(
      update.attributeKeys.contains(kSecValueData as String),
      "the attributes must carry the value the write applies")
    XCTAssertTrue(
      update.attributeKeys.contains(kSecAttrAccessible as String),
      "the attributes must carry the device-only accessibility policy")
  }

  func testTheUpdateAttributesCarryNoIdentityQueryKeys() {
    let operations = FakeKeychainOperations(storedToken: "synthetic-old-token")
    let store = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)",
      account: "device-token",
      operations: operations
    )

    XCTAssertTrue(store.write("synthetic-new-token"))

    guard let update = operations.updateCalls.first else {
      return XCTFail("a write must reach the adapter as an update")
    }
    let identity = [kSecClass as String, kSecAttrService as String, kSecAttrAccount as String]
    XCTAssertTrue(
      update.attributeKeys.isDisjoint(with: identity),
      "the attributes must not repeat the query's identity keys: \(update.attributeKeys)")
  }

  func testAFailedUpdateKeepsTheStoredPairingAndStopsThere() {
    let statuses: [(status: OSStatus, why: String)] = [
      (errSecInteractionNotAllowed, "the device refused to unlock the item"),
      (errSecAuthFailed, "authentication for the item failed"),
      (errSecParam, "the request was malformed"),
    ]

    for testCase in statuses {
      let operations = FakeKeychainOperations(storedToken: "synthetic-old-token")
      operations.updateStatus = testCase.status
      let store = KeychainStore(
        service: "app.orbis.tests.\(UUID().uuidString)",
        account: "device-token",
        operations: operations
      )

      XCTAssertFalse(
        store.write("synthetic-new-token"),
        "a failed update must report failure when \(testCase.why)")
      XCTAssertEqual(
        operations.callOrder, ["update"],
        "a failed update must not delete or add when \(testCase.why)")
      XCTAssertEqual(
        operations.storedToken, "synthetic-old-token",
        "the stored pairing must survive when \(testCase.why)")
    }
  }

  func testAnAbsentItemThatCannotBeAddedReportsFailureWithoutDeleting() {
    let operations = FakeKeychainOperations()
    operations.updateStatus = errSecItemNotFound
    operations.addStatus = errSecParam
    let store = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)",
      account: "device-token",
      operations: operations
    )

    XCTAssertFalse(store.write("synthetic-first-token"))
    XCTAssertEqual(operations.callOrder, ["update", "add"], "one add, and no recovery loop")
    XCTAssertNil(operations.storedToken, "a failed first save must not read as stored")
  }

  func testADuplicateItemOnAddIsReportedWithoutDeletingTheExistingOne() {
    let operations = FakeKeychainOperations(storedToken: "synthetic-competing-token")
    operations.updateStatus = errSecItemNotFound
    operations.addStatus = errSecDuplicateItem
    let store = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)",
      account: "device-token",
      operations: operations
    )

    XCTAssertFalse(store.write("synthetic-first-token"))
    XCTAssertEqual(operations.callOrder, ["update", "add"], "a duplicate must not become a loop")
    XCTAssertEqual(
      operations.storedToken, "synthetic-competing-token",
      "the item another writer created must not be deleted")
  }

  func testTheAddDictionaryCarriesIdentityAndTheValueAttributes() {
    let operations = FakeKeychainOperations()
    operations.updateStatus = errSecItemNotFound
    let store = KeychainStore(
      service: "app.orbis.tests.\(UUID().uuidString)",
      account: "device-token",
      operations: operations
    )

    XCTAssertTrue(store.write("synthetic-first-token"))

    guard let added = operations.addCalls.first else {
      return XCTFail("an absent item must reach the adapter as an add")
    }
    XCTAssertEqual(operations.addCalls.count, 1)
    XCTAssertTrue(
      added.isSuperset(of: [
        kSecClass as String, kSecAttrService as String, kSecAttrAccount as String,
        kSecValueData as String, kSecAttrAccessible as String,
      ]),
      "the add must carry identity and value together: \(added)")
  }
}

@MainActor
final class FakeKeychainOperations: KeychainOperations {
  enum Call: Equatable {
    case update(queryKeys: Set<String>, attributeKeys: Set<String>)
    case add(attributeKeys: Set<String>)
    case read
    case delete
  }

  var updateStatus: OSStatus = errSecSuccess
  var addStatus: OSStatus = errSecSuccess
  private(set) var calls: [Call] = []
  private var stored: Data?

  init(storedToken: String? = nil) {
    stored = storedToken.map { Data($0.utf8) }
  }

  var storedToken: String? {
    stored.map { String(decoding: $0, as: UTF8.self) }
  }

  var callOrder: [String] {
    calls.map {
      switch $0 {
      case .update: "update"
      case .add: "add"
      case .read: "read"
      case .delete: "delete"
      }
    }
  }

  var updateCalls: [(queryKeys: Set<String>, attributeKeys: Set<String>)] {
    calls.compactMap {
      guard case .update(let queryKeys, let attributeKeys) = $0 else { return nil }
      return (queryKeys, attributeKeys)
    }
  }

  var addCalls: [Set<String>] {
    calls.compactMap {
      guard case .add(let attributeKeys) = $0 else { return nil }
      return attributeKeys
    }
  }

  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    calls.append(.update(queryKeys: Set(query.keys), attributeKeys: Set(attributes.keys)))
    if updateStatus == errSecSuccess, let data = attributes[kSecValueData as String] as? Data {
      stored = data
    }
    return updateStatus
  }

  func add(attributes: [String: Any]) -> OSStatus {
    calls.append(.add(attributeKeys: Set(attributes.keys)))
    if addStatus == errSecSuccess, let data = attributes[kSecValueData as String] as? Data {
      stored = data
    }
    return addStatus
  }

  func read(query: [String: Any]) -> Data? {
    calls.append(.read)
    return stored
  }

  func delete(query: [String: Any]) -> OSStatus {
    calls.append(.delete)
    stored = nil
    return errSecSuccess
  }
}
