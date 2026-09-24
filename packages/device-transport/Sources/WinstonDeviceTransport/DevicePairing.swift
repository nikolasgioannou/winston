import Foundation
import WinstonDeviceProtocol

public struct PairedDevice: Sendable {
  public let id: String
  public let name: String
  public let credential: String
}

private struct PairingResponse: Decodable {
  struct Device: Decodable {
    let id: String
    let name: String
    let platform: String
    let protocolVersion: Int
    let revoked: Bool
  }
  let device: Device
  let credential: String
}

public enum DevicePairing {
  public static func pair(
    origin: URL, token: String, appVersion: String, capabilities: [DeviceCapability],
    allowInsecureLoopback: Bool = false
  ) async throws -> PairedDevice {
    let loopback = ["127.0.0.1", "localhost", "[::1]"].contains(origin.host ?? "")
    guard
      origin.scheme == "https" || (allowInsecureLoopback && origin.scheme == "http" && loopback),
      origin.host != nil, origin.user == nil, origin.password == nil,
      origin.query == nil, origin.fragment == nil, origin.path.isEmpty || origin.path == "/",
      token.range(of: "^wdp_[A-Za-z0-9_-]{43}\\z", options: .regularExpression) != nil,
      appVersion.count <= 64,
      appVersion.range(of: "^[A-Za-z0-9][A-Za-z0-9.+-]*\\z", options: .regularExpression) != nil,
      capabilities.count <= 6, Set(capabilities).count == capabilities.count
    else { throw DeviceTransportError.invalidConfiguration }

    let client = isolatedSession(resourceTimeout: 10)
    defer { client.invalidateAndCancel() }
    var request = URLRequest(url: origin.appendingPathComponent("callbacks/devices/pair"))
    request.httpMethod = "POST"
    request.timeoutInterval = 10
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "platform": "macos", "appVersion": appVersion, "protocolVersion": 1,
      "capabilities": capabilities.map(\.rawValue),
    ])
    do {
      return try await withTaskCancellationHandler {
        let (bytes, response) = try await client.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 201 else {
          throw DeviceTransportError.unavailable
        }
        var data = Data()
        for try await byte in bytes {
          try Task.checkCancellation()
          guard data.count < 16_384 else { throw DeviceTransportError.unavailable }
          data.append(byte)
        }
        let result = try JSONDecoder().decode(PairingResponse.self, from: data)
        guard result.device.platform == "macos", result.device.protocolVersion == 1,
          !result.device.revoked,
          result.device.id.range(
            of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z",
            options: .regularExpression) != nil,
          !result.device.name.isEmpty, result.device.name.count <= 100,
          result.device.name.rangeOfCharacter(from: .controlCharacters) == nil,
          result.credential.range(of: "^wdi_[A-Za-z0-9_-]{43}\\z", options: .regularExpression)
            != nil
        else { throw DeviceTransportError.unavailable }
        return PairedDevice(
          id: result.device.id, name: result.device.name, credential: result.credential)
      } onCancel: {
        client.invalidateAndCancel()
      }
    } catch {
      // Pairing may have completed remotely. Leave retry decisions to a new owner-issued code.
      throw DeviceTransportError.unavailable
    }
  }
}
