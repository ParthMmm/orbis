import Foundation
import Security

/// The service address is not a secret, so it lives in defaults. The device token is a
/// credential, so it lives in the keychain and never syncs to another device.
enum ClientSettings {
  private static let addressKey = "orbis.serviceAddress"

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

  static var serviceAddress: String? {
    get { UserDefaults.standard.string(forKey: addressKey) ?? developmentConfiguration?.address }
    set { UserDefaults.standard.set(newValue, forKey: addressKey) }
  }

  static var deviceToken: String? {
    Keychain.read() ?? developmentConfiguration?.token
  }

  /// Stores the pairing, answering whether this device really holds it. A write that fails
  /// must not read as a saved token: the caller learns the truth here instead of on the
  /// next launch.
  @discardableResult
  static func store(deviceToken newToken: String?) -> Bool {
    guard let newToken else {
      Keychain.delete()
      return true
    }
    return Keychain.write(newToken)
  }

  static var isConfigured: Bool {
    serviceAddress?.isEmpty == false && deviceToken?.isEmpty == false
  }

  static func configuredClient(session: URLSession = .shared) -> OrbisClient? {
    guard let address = serviceAddress, let token = deviceToken,
      let url = URL(string: address), OrbisClient.accepts(url), !token.isEmpty
    else { return nil }
    return OrbisClient(address: url, token: token, session: session)
  }
}

private enum Keychain {
  private static let service = "app.orbis.client"
  private static let account = "device-token"

  private static var base: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  static func write(_ token: String) -> Bool {
    var attributes = base
    attributes[kSecValueData as String] = Data(token.utf8)
    attributes[kSecAttrAccessible as String] =
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    // Update first, so a token that is already held stays held even when a write fails.
    // Adding only when there is nothing to update keeps a failed first save from reading
    // as a stored pairing. An item that cannot be updated in place is replaced whole,
    // because the new token is complete either way.
    switch SecItemUpdate(base as CFDictionary, attributes as CFDictionary) {
    case errSecSuccess:
      return true
    // Nothing stored yet, so adding is the whole job.
    case errSecItemNotFound:
      return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    default:
      SecItemDelete(base as CFDictionary)
      return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }
  }

  static func read() -> String? {
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(decoding: data, as: UTF8.self)
  }

  static func delete() {
    SecItemDelete(base as CFDictionary)
  }
}
