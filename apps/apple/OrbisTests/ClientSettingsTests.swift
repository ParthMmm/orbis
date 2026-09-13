import Foundation
import XCTest

@testable import Orbis

/// Pairing storage is the one place the app writes a credential, so a test that reaches it
/// would overwrite a real pairing. These cases prove that every path a test can take lands in
/// a store of its own.
@MainActor
final class ClientSettingsTests: XCTestCase {
  /// A live store reachable only by this test: its own defaults suite, its own keychain
  /// namespace, and the development file switched off. The values are synthetic; nothing here
  /// names a real service or a real token.
  private func isolatedLiveSettings() -> (settings: LiveClientSettings, cleanup: () -> Void) {
    let suite = "app.orbis.tests.\(UUID().uuidString)"
    let service = "app.orbis.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    let keychain = KeychainStore(service: service, account: "device-token")
    let settings = LiveClientSettings(
      defaults: defaults,
      keychain: keychain,
      developmentConfiguration: { nil }
    )
    return (
      settings,
      {
        keychain.delete()
        defaults.removePersistentDomain(forName: suite)
      }
    )
  }

  func testMemoryStoresDoNotShareAddressOrToken() {
    let first = MemoryClientSettings()
    let second = MemoryClientSettings()

    first.serviceAddress = "https://first.example"
    XCTAssertTrue(first.store(deviceToken: "first-token"))

    XCTAssertEqual(first.serviceAddress, "https://first.example")
    XCTAssertEqual(first.deviceToken, "first-token")
    XCTAssertNil(second.serviceAddress)
    XCTAssertNil(second.deviceToken)
  }

  /// Forgetting and pairing again through a model must move only the store that model was
  /// given. A store the model never saw is the proof that nothing global was touched.
  func testForgettingAndConnectingChangeOnlyTheInjectedStore() async {
    let sentinel = MemoryClientSettings()
    sentinel.serviceAddress = "https://sentinel.example"
    XCTAssertTrue(sentinel.store(deviceToken: "synthetic-sentinel-token"))

    let settings = MemoryClientSettings()
    settings.serviceAddress = "https://stale.example"
    XCTAssertTrue(settings.store(deviceToken: "synthetic-stale-token"))

    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "synthetic-token",
        session: StubProtocol.session { request in
          switch request.url?.path() {
          case "/health": (200, #"{"status":"ok"}"#)
          case "/sets": (200, #"{"sets":[]}"#)
          case "/playlists": (200, #"{"playlists":[]}"#)
          default: (500, "{}")
          }
        }
      ),
      settings: settings
    )

    model.connectionAddress = "https://vanta.example.ts.net"
    model.connectionToken = "synthetic-fresh-token"
    await model.connect()

    XCTAssertNil(model.connectionFailure)
    XCTAssertEqual(settings.serviceAddress, "https://vanta.example.ts.net")
    XCTAssertEqual(settings.deviceToken, "synthetic-fresh-token")
    XCTAssertEqual(
      sentinel.serviceAddress, "https://sentinel.example",
      "an independent store must stay untouched")
    XCTAssertEqual(sentinel.deviceToken, "synthetic-sentinel-token")

    model.forget()

    XCTAssertNil(settings.serviceAddress, "forgetting must clear the store the model was given")
    XCTAssertNil(settings.deviceToken)
    XCTAssertEqual(sentinel.serviceAddress, "https://sentinel.example")
    XCTAssertEqual(sentinel.deviceToken, "synthetic-sentinel-token")
  }

  /// A hosted test must land in memory even when the scheme's override went missing or was
  /// mistyped, and the live store must not be built on the way there.
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

  /// The real store is exercised the way a device uses it: write, replace, clear. Only the
  /// namespace this test created is ever touched.
  func testALiveStoreRoundTripsThroughIsolatedDefaultsAndKeychain() {
    let (settings, cleanup) = isolatedLiveSettings()
    defer { cleanup() }

    XCTAssertFalse(settings.isConfigured)

    settings.serviceAddress = "https://isolated.example"
    XCTAssertTrue(settings.store(deviceToken: "synthetic-first-token"))
    XCTAssertEqual(settings.serviceAddress, "https://isolated.example")
    XCTAssertEqual(settings.deviceToken, "synthetic-first-token")
    XCTAssertTrue(settings.isConfigured)

    XCTAssertTrue(settings.store(deviceToken: "synthetic-second-token"))
    XCTAssertEqual(
      settings.deviceToken, "synthetic-second-token",
      "the replacement must not have lost the stored pairing")

    XCTAssertTrue(settings.store(deviceToken: nil))
    XCTAssertNil(settings.deviceToken)
    settings.serviceAddress = nil
    XCTAssertNil(settings.serviceAddress)
    XCTAssertFalse(settings.isConfigured)
  }

  func testClearingOneIsolatedNamespaceLeavesAnotherAlone() {
    let (first, cleanFirst) = isolatedLiveSettings()
    let (second, cleanSecond) = isolatedLiveSettings()
    defer {
      cleanFirst()
      cleanSecond()
    }

    first.serviceAddress = "https://first.example"
    XCTAssertTrue(first.store(deviceToken: "synthetic-first-token"))
    second.serviceAddress = "https://second.example"
    XCTAssertTrue(second.store(deviceToken: "synthetic-second-token"))

    first.serviceAddress = nil
    XCTAssertTrue(first.store(deviceToken: nil))

    XCTAssertNil(first.serviceAddress)
    XCTAssertNil(first.deviceToken)
    XCTAssertEqual(second.serviceAddress, "https://second.example")
    XCTAssertEqual(second.deviceToken, "synthetic-second-token")
  }

  /// The address rules are the same ones the client enforces: TLS or loopback, a real host,
  /// and both halves of the pairing present.
  func testConfiguredClientKeepsAddressValidation() {
    let settings = MemoryClientSettings()
    XCTAssertNil(settings.configuredClient(), "an empty store must not configure a client")

    settings.serviceAddress = "https://vanta.example.ts.net"
    XCTAssertNil(
      settings.configuredClient(), "an address without a token must not configure a client")

    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    XCTAssertNotNil(settings.configuredClient())

    settings.serviceAddress = "http://vanta.example.ts.net"
    XCTAssertNil(settings.configuredClient(), "the token rides only over TLS or loopback")

    settings.serviceAddress = "not a url"
    XCTAssertNil(settings.configuredClient(), "an address that is not a URL is refused")

    settings.serviceAddress = "https://vanta.example.ts.net"
    XCTAssertTrue(settings.store(deviceToken: ""))
    XCTAssertNil(settings.configuredClient(), "an empty token must not configure a client")
  }

  /// The reset launch argument is exercised against a supplied store, so the proof does not
  /// need an app started against a real pairing.
  func testTheResetLaunchArgumentClearsOnlyTheInjectedStore() {
    let settings = MemoryClientSettings()
    settings.serviceAddress = "https://stale.example"
    XCTAssertTrue(settings.store(deviceToken: "synthetic-stale-token"))

    AppModel.resetSettings(ifRequestedBy: [], in: settings)
    XCTAssertEqual(
      settings.deviceToken, "synthetic-stale-token",
      "without the reset argument the store must be left alone")
    XCTAssertEqual(settings.serviceAddress, "https://stale.example")

    AppModel.resetSettings(ifRequestedBy: ["-orbisResetSettings"], in: settings)
    XCTAssertNil(settings.serviceAddress)
    XCTAssertNil(settings.deviceToken)
  }

  /// Every write must reach Security through the injected adapter, so a test can hold the
  /// statuses a real keychain would not produce on demand. The query and the attributes stay
  /// separately visible, because the write policy depends on that split.
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

  /// `SecItemUpdate` takes the item class and the search properties in its query, not among
  /// the attributes it applies. Copying the identity into the attributes is what made the old
  /// failure branch look like a whole-item replacement, so the split is asserted directly.
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

  /// A status that is neither success nor "nothing stored yet" means the write did not
  /// happen. Deleting the item that could not be updated would throw away the pairing this
  /// device already holds, and the add that followed could fail too.
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

  /// Nothing was stored, so the write's whole job is one add. If that add fails there is still
  /// nothing to delete, and the caller must hear the truth rather than a stored pairing.
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

  /// Another writer can create the item between the update that found nothing and the add.
  /// That add fails, and the competing item is the one that must survive.
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

  /// An add creates the whole item, so it carries the identity the update query carried plus
  /// the value attributes. Only the query stays identity-only.
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

/// A Security adapter that never reaches the system keychain. It holds one fixture value,
/// records every call and the dictionary keys it was handed, and answers with the statuses a
/// test chose. Nothing here can touch a real pairing, so the failure paths are provable
/// without locking, corrupting, or deleting a developer's stored credential.
@MainActor
final class FakeKeychainOperations: KeychainOperations {
  /// One recorded call. The keys are kept rather than the dictionaries, because the
  /// dictionaries are not comparable and the keys are what the assertions turn on.
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

  /// What the fake holds, which is what a real keychain would hand back on the next read.
  var storedToken: String? {
    stored.map { String(decoding: $0, as: UTF8.self) }
  }

  /// The calls in order, so a test can prove nothing extra happened.
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
