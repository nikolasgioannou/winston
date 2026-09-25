import Foundation
import ProxyFiles
import WinstonDeviceProtocol

public enum DeviceFileDownloadError: Error, Equatable {
  case invalidConfiguration
  case invalidRequest
  case deadline
  case invalidResponse
}

public struct DeviceFileDownloader: Sendable {
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
      deviceId.range(
        of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z",
        options: .regularExpression) != nil,
      credential.range(of: "^wdi_[A-Za-z0-9_-]{43}\\z", options: .regularExpression) != nil
    else { throw DeviceFileDownloadError.invalidConfiguration }
    self.origin = origin
    self.deviceId = deviceId
    self.credential = credential
  }

  public func write(
    _ message: DeviceMessage, session: DeviceSession, root: FileWriteRoot
  ) async throws -> FileWriteReceipt {
    guard message.deviceId == deviceId, session.deviceId == deviceId,
      message.sessionId == session.sessionId, message.generation == session.generation,
      case .execute(
        let binding, let deadline, .fileWrite(let path, let transferId, let overwrite, let source)) =
        message.payload,
      let transfer = UUID(uuidString: transferId)
    else { throw DeviceFileDownloadError.invalidRequest }
    let timeout = min(50, Double(deadline) / 1000 - Date().timeIntervalSince1970)
    guard timeout > 0 else { throw DeviceFileDownloadError.deadline }
    try Task.checkCancellation()
    var request = URLRequest(url: origin.appendingPathComponent("api/devices/files/download"))
    request.httpMethod = "POST"
    request.timeoutInterval = timeout
    request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "version": 1,
      "authority": [
        "session": [
          "deviceId": deviceId, "sessionId": session.sessionId, "generation": session.generation,
        ],
        "executionId": binding.executionId, "transferId": transferId, "operation": "file.write",
      ],
    ])
    return try await BoundedFileDownload.receive(
      request, source: source, timeout: timeout, root: root,
      path: path, transferId: transfer, overwrite: overwrite)
  }
}
