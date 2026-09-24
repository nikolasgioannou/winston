import Foundation

public enum DeviceIdentityError: Error {
  case invalidIdentity
  case keychainStatus(Int32)
}

public struct StoredDeviceIdentity: Codable, Sendable {
  private let version: Int
  public let origin: URL
  public let deviceId: String
  public let name: String
  public let credential: String

  public init(origin: URL, deviceId: String, name: String, credential: String) throws {
    guard origin.scheme == "https", origin.host != nil,
      origin.absoluteString.count <= 2048,
      origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
      origin.path.isEmpty || origin.path == "/",
      deviceId.range(
        of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z",
        options: .regularExpression) != nil,
      !name.isEmpty, name.count <= 100, name.rangeOfCharacter(from: .controlCharacters) == nil,
      credential.range(of: "^wdi_[A-Za-z0-9_-]{43}\\z", options: .regularExpression) != nil
    else { throw DeviceIdentityError.invalidIdentity }
    version = 1
    self.origin = origin
    self.deviceId = deviceId
    self.name = name
    self.credential = credential
  }

  public static func decode(_ data: Data) throws -> StoredDeviceIdentity {
    guard data.count <= 16_384 else { throw DeviceIdentityError.invalidIdentity }
    do {
      let identity = try JSONDecoder().decode(Self.self, from: data)
      guard identity.version == 1 else { throw DeviceIdentityError.invalidIdentity }
      return try Self(
        origin: identity.origin, deviceId: identity.deviceId, name: identity.name,
        credential: identity.credential)
    } catch { throw DeviceIdentityError.invalidIdentity }
  }
}
