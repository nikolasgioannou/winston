import CryptoKit
import Darwin
import Foundation
import ProxyFileTransfer
import ProxyFiles
import WinstonDeviceProtocol

enum FixtureFailure: Error { case failed(String) }
final class Completion: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false
  func finish() {
    lock.lock()
    completed = true
    lock.unlock()
  }
  func isFinished() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return completed
  }
}
func require(_ condition: @autoclosure () throws -> Bool, _ detail: String) throws {
  if try !condition() { throw FixtureFailure.failed(detail) }
}

guard let resolved = realpath(CommandLine.arguments[1], nil),
  let origin = URL(string: CommandLine.arguments[2])
else { throw FixtureFailure.failed("Fixture arguments") }
let directory = String(cString: resolved)
free(resolved)
let scenario = CommandLine.arguments[3]
let root = try FileWriteRoot(path: directory)
let path = directory + "/destination"
let content = Data(
  repeating: 42, count: scenario == "empty" ? 0 : scenario == "largeReady" ? 2_000_000 : 180_000)
let original = Data("existing file".utf8)
if scenario == "replace" || scenario == "collision" {
  try original.write(to: URL(fileURLWithPath: path))
}
let source = try DeviceFileSource(
  artifactId: "66666666-6666-4666-8666-666666666666", revision: 2,
  size: Int64(content.count),
  sha256: SHA256.hash(data: content).map { String(format: "%02x", $0) }.joined())
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
let downloader = try DeviceFileDownloader(
  origin: origin, deviceId: deviceId, credential: credential, allowInsecureLoopback: true)
let deadline =
  Int64(Date().timeIntervalSince1970 * 1000)
  + (scenario == "deadline" ? -1 : scenario == "timeout" ? 1000 : 30_000)
let message = try DeviceMessage(
  messageId: UUID().uuidString.lowercased(), correlationId: UUID().uuidString.lowercased(),
  deviceId: deviceId,
  sessionId: scenario == "invalidRequest" ? UUID().uuidString.lowercased() : sessionId,
  generation: 1,
  payload: .execute(
    binding, deadline: deadline,
    operation: .fileWrite(
      path: path, transferId: transferId, overwrite: scenario == "replace", source: source)))
let succeeds = ["ready", "streamed", "largeReady", "empty", "replace"].contains(scenario)
let started = ContinuousClock.now
var failed = false
var failure: Error?
if scenario == "canceled" {
  let completion = Completion()
  let running = Task.detached {
    defer { completion.finish() }
    return try await downloader.write(message, session: session, root: root)
  }
  guard readLine() == "cancel" else { throw FixtureFailure.failed("Cancellation handshake") }
  try require(!completion.isFinished(), "Transfer was still pending before cancellation")
  running.cancel()
  do { _ = try await running.value } catch {
    failed = true
    failure = error
  }
} else {
  do {
    let result = try await downloader.write(message, session: session, root: root)
    try require(result.size == source.size && result.sha256 == source.sha256, "Write receipt")
  } catch {
    failed = true
    failure = error
  }
}
try require(failed != succeeds, "Expected outcome for \(scenario)")
if scenario == "corrupt" {
  try require(failure as? FileWriteError == .contentMismatch, "Checksum failure")
}
if scenario == "collision" {
  try require(failure as? FileWriteError == .collision, "Collision failure")
}
if scenario == "deadline" {
  try require(failure as? DeviceFileDownloadError == .deadline, "Expired execution")
}
if scenario == "invalidRequest" {
  try require(failure as? DeviceFileDownloadError == .invalidRequest, "Session mismatch")
}
if scenario == "timeout" {
  try require(
    started.duration(to: .now) >= .milliseconds(500), "Waited for the stalled transfer deadline")
}
let files = try FileManager.default.contentsOfDirectory(atPath: directory)
try require(
  !files.contains(where: { $0.hasPrefix(".winston-transfer-") }), "Temporary file cleanup")
if succeeds {
  try require(
    try Data(contentsOf: URL(fileURLWithPath: path)) == content, "Verified destination bytes")
} else if scenario == "collision" {
  try require(
    try Data(contentsOf: URL(fileURLWithPath: path)) == original, "Original destination retained")
} else {
  try require(!FileManager.default.fileExists(atPath: path), "Failed download never publishes")
}
for bad in [
  "http://example.com", "https://example.com/path", "https://owner:password@example.com",
  "https://example.com?token=bad",
] {
  do {
    _ = try DeviceFileDownloader(
      origin: URL(string: bad)!, deviceId: deviceId, credential: credential,
      allowInsecureLoopback: true)
    throw FixtureFailure.failed("Invalid origin accepted")
  } catch DeviceFileDownloadError.invalidConfiguration {}
}
print("Native file download checks passed")
