import Foundation

/// Shared keychain identity for the main app and share extension.
enum OrbisSharedIdentity {
  static let keychainService = "app.orbis.client"
  static let keychainAccount = "device-token"
  /// Team-prefixed access group from entitlements (`$(AppIdentifierPrefix)app.orbis.client`).
  /// When nil (tests), the keychain item has no access group.
  static let keychainAccessGroup = "JR398S689Z.app.orbis.client"
}
