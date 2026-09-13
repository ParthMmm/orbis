import Foundation
import Security

/// Where the pairing lives: the service address and the device token.
///
/// The app reads and writes settings through this interface, so a test can hand a model a
/// store of its own and prove what the app does without reaching a real pairing. The address
/// is not a secret and may live in defaults; the token is a credential and belongs in the
/// keychain.
@MainActor
protocol ClientSettingsStore: AnyObject {
  var serviceAddress: String? { get set }

  /// The stored device token, or nil when this device holds no pairing.
  var deviceToken: String? { get }

  /// Stores the pairing, answering whether this device really holds it. A write that fails
  /// must not read as a saved token: the caller learns the truth here instead of on the
  /// next launch.
  @discardableResult
  func store(deviceToken newToken: String?) -> Bool
}

extension ClientSettingsStore {
  var isConfigured: Bool {
    serviceAddress?.isEmpty == false && deviceToken?.isEmpty == false
  }

  func configuredClient(session: URLSession = .shared) -> OrbisClient? {
    guard let address = serviceAddress, let token = deviceToken,
      let url = URL(string: address), OrbisClient.accepts(url), !token.isEmpty
    else { return nil }
    return OrbisClient(address: url, token: token, session: session)
  }
}

/// The device's own storage: the address in defaults and the token in the keychain, with a
/// development file as a fallback for a build on the developer's Mac.
@MainActor
final class LiveClientSettings: ClientSettingsStore {
  private static let addressKey = "orbis.serviceAddress"

  private let defaults: UserDefaults
  private let keychain: KeychainStore
  private let developmentConfiguration: () -> (address: String, token: String)?

  /// Dependencies are explicit so a test can supply a defaults suite of its own, a keychain
  /// namespace of its own, and a provider that answers nil. The provider is held rather than
  /// called, so constructing a store never opens the development file.
  init(
    defaults: UserDefaults,
    keychain: KeychainStore,
    developmentConfiguration: @escaping () -> (address: String, token: String)?
  ) {
    self.defaults = defaults
    self.keychain = keychain
    self.developmentConfiguration = developmentConfiguration
  }

  var serviceAddress: String? {
    get { defaults.string(forKey: Self.addressKey) ?? developmentConfiguration()?.address }
    set { defaults.set(newValue, forKey: Self.addressKey) }
  }

  var deviceToken: String? {
    keychain.read() ?? developmentConfiguration()?.token
  }

  @discardableResult
  func store(deviceToken newToken: String?) -> Bool {
    guard let newToken else {
      keychain.delete()
      return true
    }
    return keychain.write(newToken)
  }
}

/// A store that keeps the pairing in memory and nowhere else. Two instances never share
/// state, so what a test writes cannot reach another test or a real pairing.
@MainActor
final class MemoryClientSettings: ClientSettingsStore {
  var serviceAddress: String?
  private var token: String?

  var deviceToken: String? { token }

  @discardableResult
  func store(deviceToken newToken: String?) -> Bool {
    token = newToken
    return true
  }
}

/// The store the running app should use. The Debug path keeps tests off the device's real
/// pairing; a release build always uses the device's own storage.
enum ClientSettings {
  /// A development convenience. A build on this machine reads the service address and a device
  /// token from `~/.orbis/config.json`, so neither is retyped after a settings reset or a
  /// fresh install. The file sits outside the repository, so no credential is committed, and
  /// a stored value always wins over it.
  ///
  /// macOS only, because the file is a path on the Mac and a phone has no such home directory.
  static var developmentConfiguration: (address: String, token: String)? {
    #if DEBUG && os(macOS)
      let file = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".orbis/config.json")
      guard let data = try? Data(contentsOf: file),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
        let address = json["serviceAddress"],
        let token = json["deviceToken"],
        !address.isEmpty, !token.isEmpty
      else { return nil }
      return (address, token)
    #else
      return nil
    #endif
  }

  static let testSettingsKey = "ORBIS_TEST_SETTINGS"
  static let memoryMode = "memory"

  @MainActor
  static func forCurrentProcess() -> any ClientSettingsStore {
    #if DEBUG
      let environment = ProcessInfo.processInfo.environment
      // A test bundle is loaded into this process, so both the runtime lookup and the launch
      // variables name a running test. They stand behind the hosted scheme's explicit memory
      // mode rather than replacing it, and they fail closed: a recognized test that is
      // missing the override still selects memory.
      let isTestHost =
        NSClassFromString("XCTestCase") != nil
        || environment["XCTestConfigurationFilePath"] != nil
        || environment["XCTestSessionIdentifier"] != nil
      return makeForProcess(
        environment: environment,
        isTestHost: isTestHost,
        liveStore: makeLiveStore
      )
    #else
      return makeLiveStore()
    #endif
  }

  /// Selects the store for a Debug process. Memory mode and a recognized test host both
  /// select memory without calling the live constructor, so no test can reach a real
  /// pairing even when the override is missing or mistyped.
  @MainActor
  static func makeForProcess(
    environment: [String: String],
    isTestHost: Bool,
    liveStore: @MainActor () -> any ClientSettingsStore
  ) -> any ClientSettingsStore {
    if environment[testSettingsKey] == memoryMode || isTestHost {
      return MemoryClientSettings()
    }
    return liveStore()
  }

  /// The device's own storage: the existing defaults, the production keychain identity, and
  /// the home-file fallback, which stays lazy until a read asks for it.
  @MainActor
  private static func makeLiveStore() -> any ClientSettingsStore {
    LiveClientSettings(
      defaults: .standard,
      keychain: KeychainStore(service: "app.orbis.client", account: "device-token"),
      developmentConfiguration: { developmentConfiguration }
    )
  }
}

/// The Security framework operations one keychain namespace needs. The live adapter calls the
/// same functions the store used to call directly; a test adapter records the calls it was
/// handed and answers with statuses it chose, so a failure path can be proven without a real
/// keychain and without an unsafe annotation.
@MainActor
protocol KeychainOperations {
  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus
  func add(attributes: [String: Any]) -> OSStatus
  func read(query: [String: Any]) -> Data?
  func delete(query: [String: Any]) -> OSStatus
}

/// The device's real keychain. Every method here is the framework call the store made before
/// the seam existed, so production behavior is unchanged.
@MainActor
struct LiveKeychainOperations: KeychainOperations {
  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  }

  func add(attributes: [String: Any]) -> OSStatus {
    SecItemAdd(attributes as CFDictionary, nil)
  }

  func read(query: [String: Any]) -> Data? {
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return data
  }

  func delete(query: [String: Any]) -> OSStatus {
    SecItemDelete(query as CFDictionary)
  }
}

/// One keychain namespace, named by its service and account. Production supplies the app's own
/// identity; a test supplies a unique `app.orbis.tests.<UUID>` service, so nothing it writes
/// can reach a real pairing. The Security calls arrive through an injected adapter, which is
/// how a test proves a write failure without touching a real keychain.
@MainActor
struct KeychainStore {
  let service: String
  let account: String
  private let operations: any KeychainOperations

  init(
    service: String,
    account: String,
    operations: any KeychainOperations = LiveKeychainOperations()
  ) {
    self.service = service
    self.account = account
    self.operations = operations
  }

  /// The class, service, and account that name one keychain item. These keys belong in a
  /// query: `SecItemUpdate` refuses an item class or a search property among the attributes it
  /// applies.
  private var identity: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  /// What a write changes about an item: the value and the policy that keeps the credential on
  /// this device alone, out of backups and out of iCloud Keychain.
  private var valueAttributes: [String: Any] {
    [kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
  }

  func write(_ token: String) -> Bool {
    var attributes = valueAttributes
    attributes[kSecValueData as String] = Data(token.utf8)
    // Update first, so a token that is already held stays held even when a write fails.
    // Adding only when there is nothing to update keeps a failed first save from reading
    // as a stored pairing.
    switch operations.update(query: identity, attributes: attributes) {
    case errSecSuccess:
      return true
    // Nothing stored yet, so adding is the whole job. An add creates the item, so it carries
    // the identity the query carried as well as the value.
    case errSecItemNotFound:
      var addAttributes = identity
      addAttributes.merge(attributes) { _, value in value }
      return operations.add(attributes: addAttributes) == errSecSuccess
    default:
      // Any other status means the stored item is still there and still holds the old token.
      // Deleting what could not be updated would throw away a working pairing, and the add
      // that followed could fail too, so the write reports failure and changes nothing. A
      // duplicate on the add above is the same answer for the same reason: another writer's
      // item is not this write's to remove.
      return false
    }
  }

  func read() -> String? {
    var query = identity
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    guard let data = operations.read(query: query) else { return nil }
    return String(decoding: data, as: UTF8.self)
  }

  func delete() {
    operations.delete(query: identity)
  }
}
