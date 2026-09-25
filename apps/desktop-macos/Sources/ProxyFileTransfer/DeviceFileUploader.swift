import Foundation
import ProxyFiles
import WinstonDeviceProtocol

public enum DeviceFileUploadError: Error, Equatable {
  case invalidConfiguration
  case invalidRequest
  case deadline
  case denied
  case conflict
  case invalidFile
  case uncertain
}

public struct DeviceFileUploadReceipt: Sendable {
  public let artifactId: String
  public let revision: Int64
  public let transferId: String
  public let size: Int64
  public let sha256: String
}

public struct DeviceFileUploader: Sendable {
  private let origin: URL
  private let deviceId: String
  private let credential: String

  public init(
    origin: URL, deviceId: String, credential: String,
    allowInsecureLoopback: Bool = false
  ) throws {
    let loopback = ["127.0.0.1", "localhost", "[::1]"].contains(origin.host ?? "")
    guard
      origin.scheme == "https" || (allowInsecureLoopback && origin.scheme == "http" && loopback),
      origin.host != nil, origin.user == nil, origin.password == nil,
      origin.query == nil, origin.fragment == nil, origin.path.isEmpty || origin.path == "/",
      validIdentifier(deviceId),
      credential.range(of: "^wdi_[A-Za-z0-9_-]{43}\\z", options: .regularExpression) != nil
    else { throw DeviceFileUploadError.invalidConfiguration }
    self.origin = origin
    self.deviceId = deviceId
    self.credential = credential
  }

  public func capture(
    _ message: DeviceMessage, session: DeviceSession,
    root: FileRoot, spool: FileRoot
  ) async throws -> DeviceFileUploadReceipt {
    guard message.deviceId == deviceId, session.deviceId == deviceId,
      message.sessionId == session.sessionId, message.generation == session.generation,
      case .execute(let binding, let deadline, .fileRead(let path, let transferId)) = message
        .payload
    else { throw DeviceFileUploadError.invalidRequest }
    let remaining = Double(deadline) / 1000 - Date().timeIntervalSince1970
    guard remaining > 0 else { throw DeviceFileUploadError.deadline }
    return try await root.withSnapshot(path: path, spool: spool, timeout: min(30, remaining)) {
      snapshot in
      let timeout = min(50, Double(deadline) / 1000 - Date().timeIntervalSince1970)
      guard timeout > 0 else { throw DeviceFileUploadError.deadline }
      try Task.checkCancellation()
      let descriptor = try JSONSerialization.data(withJSONObject: [
        "version": 1,
        "authority": [
          "session": [
            "deviceId": deviceId, "sessionId": session.sessionId, "generation": session.generation,
          ],
          "executionId": binding.executionId, "transferId": transferId, "operation": "file.read",
        ],
        "size": snapshot.size, "sha256": snapshot.sha256,
      ])
      let encoded = descriptor.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
      var request = URLRequest(url: origin.appendingPathComponent("api/devices/files/upload"))
      request.httpMethod = "POST"
      request.timeoutInterval = timeout
      request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue(String(snapshot.size), forHTTPHeaderField: "Content-Length")
      request.setValue(encoded, forHTTPHeaderField: "X-Winston-File")
      let bytes = try await BoundedFileUpload.send(request, file: snapshot.url, timeout: timeout)
      try Task.checkCancellation()
      return try readUploadReceipt(bytes, snapshot: snapshot, transferId: transferId)
    }
  }
}

private func validIdentifier(_ value: String) -> Bool {
  value.range(
    of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z",
    options: .regularExpression) != nil
}

private struct UploadResponse: Decodable {
  let version: Int64
  let status: String
  let transferId: String
  let artifactId: String?
  let revision: Int64?
  let size: Int64?
  let sha256: String?
}

private func readUploadReceipt(
  _ bytes: Data, snapshot: FileSnapshot,
  transferId: String
) throws -> DeviceFileUploadReceipt {
  guard bytes.count <= 4096,
    let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    let response = try? JSONDecoder().decode(UploadResponse.self, from: bytes),
    response.version == 1, response.transferId == transferId
  else { throw DeviceFileUploadError.uncertain }
  if response.status != "ready" {
    guard Set(object.keys) == ["version", "status", "transferId"] else {
      throw DeviceFileUploadError.uncertain
    }
    switch response.status {
    case "denied": throw DeviceFileUploadError.denied
    case "conflict": throw DeviceFileUploadError.conflict
    case "invalid_file": throw DeviceFileUploadError.invalidFile
    default: throw DeviceFileUploadError.uncertain
    }
  }
  guard
    Set(object.keys) == [
      "version", "status", "transferId", "artifactId", "revision", "size", "sha256",
    ],
    let artifactId = response.artifactId, validIdentifier(artifactId),
    let revision = response.revision, revision >= 0, revision <= 9_007_199_254_740_991,
    response.size == snapshot.size, response.sha256 == snapshot.sha256
  else { throw DeviceFileUploadError.uncertain }
  return DeviceFileUploadReceipt(
    artifactId: artifactId, revision: revision,
    transferId: transferId, size: snapshot.size, sha256: snapshot.sha256)
}
