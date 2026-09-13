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
}
