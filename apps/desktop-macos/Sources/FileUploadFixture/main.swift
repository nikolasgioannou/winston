import Darwin
import Foundation
import ProxyFileTransfer
import ProxyFiles
import WinstonDeviceProtocol

enum FixtureFailure: Error { case failed(String) }
func require(_ condition: @autoclosure () throws -> Bool, _ detail: String) throws {
  if try !condition() { throw FixtureFailure.failed(detail) }
}

guard let resolved = realpath(CommandLine.arguments[1], nil),
  let origin = URL(string: CommandLine.arguments[2])
else { throw FixtureFailure.failed("Fixture arguments") }
let directory = String(cString: resolved)
free(resolved)
let expected = CommandLine.arguments[3]
let root = try FileRoot(path: directory)
let path = directory + "/source"
let spoolPath = directory + "/spool"
try FileManager.default.createDirectory(
  atPath: spoolPath, withIntermediateDirectories: false,
  attributes: [.posixPermissions: 0o700])
let spool = try FileRoot(path: spoolPath)
let bytes = Data(repeating: 42, count: 180_000)
try bytes.write(to: URL(fileURLWithPath: path))
let deviceId = "11111111-1111-4111-8111-111111111111"
let sessionId = "22222222-2222-4222-8222-222222222222"
let transferId = "33333333-3333-4333-8333-333333333333"
let binding = ExecutionBinding(
  executionId: "44444444-4444-4444-8444-444444444444",
  taskId: "55555555-5555-4555-8555-555555555555", taskRevision: 1)
let session = try DeviceSession(
  data: JSONSerialization.data(withJSONObject: [
    "version": 1, "kind": "session", "deviceId": deviceId, "sessionId": sessionId,
    "generation": 1, "expiresAt": "2030-01-01T00:00:00.000Z",
  ]))
let credential = "wdi_" + String(repeating: "a", count: 43)
let uploader = try DeviceFileUploader(
  origin: origin, deviceId: deviceId,
  credential: credential, allowInsecureLoopback: true)
let deadline = Int64(Date().timeIntervalSince1970 * 1000) + (expected == "deadline" ? -1 : 30_000)
let message = try DeviceMessage(
  messageId: UUID().uuidString.lowercased(),
  correlationId: UUID().uuidString.lowercased(), deviceId: deviceId,
  sessionId: expected == "invalidRequest" ? UUID().uuidString.lowercased() : sessionId,
  generation: 1,
  payload: .execute(
    binding, deadline: deadline,
    operation: .fileRead(path: path, transferId: transferId)))

if expected == "canceled" {
  let running = Task.detached {
    try await uploader.capture(message, session: session, root: root, spool: spool)
  }
  // The loopback fixture writes this only after it has received the upload body.
  guard readLine() == "cancel" else { throw FixtureFailure.failed("Cancellation handshake") }
  running.cancel()
  do {
    _ = try await running.value
    throw FixtureFailure.failed("Cancellation was ignored")
  } catch is CancellationError {}
} else {
  do {
    let receipt = try await uploader.capture(message, session: session, root: root, spool: spool)
    try require(expected == "ready", "Unexpected successful upload")
    try require(receipt.transferId == transferId && receipt.size == bytes.count, "Verified receipt")
    try require(
      receipt.artifactId == "66666666-6666-4666-8666-666666666666" && receipt.revision == 1,
      "Artifact identity")
  } catch let error as DeviceFileUploadError {
    try require(String(describing: error) == expected, "Expected \(expected), got \(error)")
  }
}
try require(
  try FileManager.default.contentsOfDirectory(atPath: spoolPath).isEmpty, "Upload cleanup")
for bad in [
  "http://example.com", "https://example.com/path", "https://owner:password@example.com",
  "https://example.com?token=bad",
] {
  do {
    _ = try DeviceFileUploader(
      origin: URL(string: bad)!, deviceId: deviceId, credential: credential,
      allowInsecureLoopback: true)
    throw FixtureFailure.failed("Invalid origin accepted")
  } catch DeviceFileUploadError.invalidConfiguration {}
}
print("Native file upload checks passed")
