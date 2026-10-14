import Foundation
import Security

@MainActor
protocol ClientSettingsStore: AnyObject {
  var deviceToken: String? { get }

  @discardableResult
  func store(deviceToken newToken: String?) -> Bool
}

extension ClientSettingsStore {
  func configuredClient(address: URL, session: URLSession = .shared) -> OrbisClient? {
    guard let token = deviceToken, !token.isEmpty else { return nil }
    return OrbisClient(address: address, token: token, session: session)
  }
}

@MainActor
final class LiveClientSettings: ClientSettingsStore {
  private let keychain: KeychainStore
  private let developmentToken: () -> String?

  init(keychain: KeychainStore, developmentToken: @escaping () -> String?) {
    self.keychain = keychain
    self.developmentToken = developmentToken
  }

  var deviceToken: String? {
    keychain.read() ?? developmentToken()
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

@MainActor
final class MemoryClientSettings: ClientSettingsStore {
  private var token: String?

  var deviceToken: String? { token }

  @discardableResult
  func store(deviceToken newToken: String?) -> Bool {
    token = newToken
    return true
  }
}

enum ClientSettings {
  static var developmentConfiguration: (address: String, token: String)? {
    #if DEBUG && (os(macOS) || targetEnvironment(simulator))
      #if os(macOS)
        let home = FileManager.default.homeDirectoryForCurrentUser
      #else
        guard let hostHome = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"]
        else { return nil }
        let home = URL(filePath: hostHome, directoryHint: .isDirectory)
      #endif
      let file = home.appending(path: ".orbis/config.json")
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

  @MainActor
  private static func makeLiveStore() -> any ClientSettingsStore {
    let sharedKeychain = KeychainStore(
      service: OrbisSharedIdentity.keychainService,
      account: OrbisSharedIdentity.keychainAccount,
      accessGroup: OrbisSharedIdentity.keychainAccessGroup
    )
    migrateTokenIfNeeded(into: sharedKeychain)
    return LiveClientSettings(
      keychain: sharedKeychain,
      developmentToken: { developmentConfiguration?.token }
    )
  }

  @MainActor
  static func migrateTokenIfNeeded(into shared: KeychainStore) {
    if shared.read() != nil { return }
    let legacy = KeychainStore(
      service: OrbisSharedIdentity.keychainService,
      account: OrbisSharedIdentity.keychainAccount
    )
    guard let token = legacy.read() else { return }
    if shared.write(token) {
      legacy.delete()
    }
  }
}

@MainActor
protocol KeychainOperations {
  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus
  func add(attributes: [String: Any]) -> OSStatus
  func read(query: [String: Any]) -> Data?
  func delete(query: [String: Any]) -> OSStatus
}

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

@MainActor
struct KeychainStore {
  let service: String
  let account: String
  let accessGroup: String?
  private let operations: any KeychainOperations

  init(
    service: String,
    account: String,
    accessGroup: String? = nil,
    operations: any KeychainOperations = LiveKeychainOperations()
  ) {
    self.service = service
    self.account = account
    self.accessGroup = accessGroup
    self.operations = operations
  }

  /// The class, service, and account that name one keychain item. These keys belong in a
  /// query: `SecItemUpdate` refuses an item class or a search property among the attributes it
  /// applies.
  private var identity: [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    if let accessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    return query
  }

  private var valueAttributes: [String: Any] {
    [kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
  }

  func write(_ token: String) -> Bool {
    var attributes = valueAttributes
    attributes[kSecValueData as String] = Data(token.utf8)
    switch operations.update(query: identity, attributes: attributes) {
    case errSecSuccess:
      return true
    case errSecItemNotFound:
      var addAttributes = identity
      addAttributes.merge(attributes) { _, value in value }
      return operations.add(attributes: addAttributes) == errSecSuccess
    default:
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
    _ = operations.delete(query: identity)
  }
}
