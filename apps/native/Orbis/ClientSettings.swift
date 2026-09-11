import Foundation
import Security

/// The service address is not a secret, so it lives in defaults. The device token is a
/// credential, so it lives in the keychain and never syncs to another device.
enum ClientSettings {
    private static let addressKey = "orbis.serviceAddress"

    static var serviceAddress: String? {
        get { UserDefaults.standard.string(forKey: addressKey) }
        set { UserDefaults.standard.set(newValue, forKey: addressKey) }
    }

    static var deviceToken: String? {
        get { Keychain.read() }
        set {
            if let newValue {
                Keychain.write(newValue)
            } else {
                Keychain.delete()
            }
        }
    }

    static var isConfigured: Bool {
        serviceAddress?.isEmpty == false && deviceToken?.isEmpty == false
    }

    static func configuredClient(session: URLSession = .shared) -> OrbisClient? {
        guard let address = serviceAddress, let token = deviceToken,
              let url = URL(string: address), !token.isEmpty
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

    static func write(_ token: String) {
        SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = Data(token.utf8)
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
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
