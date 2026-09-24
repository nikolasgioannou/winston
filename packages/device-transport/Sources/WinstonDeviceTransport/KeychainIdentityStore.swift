import Foundation
import Security

public actor KeychainIdentityStore {
  private let service: String

  public init(validationIdentifier: UUID? = nil) {
    service =
      validationIdentifier.map { "app.runwinston.proxy.validation.\($0.uuidString.lowercased())" }
      ?? "app.runwinston.proxy"
  }

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrSynchronizable as String: false,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "device-identity",
    ]
  }

  public func load() throws -> StoredDeviceIdentity? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw DeviceIdentityError.keychainStatus(status) }
    guard let data = result as? Data else { throw DeviceIdentityError.invalidIdentity }
    return try StoredDeviceIdentity.decode(data)
  }

  public func save(_ identity: StoredDeviceIdentity) throws {
    let data = try JSONEncoder().encode(identity)
    _ = try StoredDeviceIdentity.decode(data)
    let values: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      let attributes = query.merging(values) { _, new in new }
      status = SecItemAdd(attributes as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw DeviceIdentityError.keychainStatus(status) }
  }

  public func remove() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw DeviceIdentityError.keychainStatus(status)
    }
  }
}
