import CryptoKit
import Darwin
import Foundation
import ProxyFiles

enum FixtureFailure: Error {
  case failed(String)
  case callback
}

func require(_ condition: @autoclosure () throws -> Bool, _ description: String) throws {
  if try !condition() { throw FixtureFailure.failed(description) }
}

let manager = FileManager.default
guard let resolved = realpath(CommandLine.arguments[1], nil) else {
  throw FixtureFailure.failed("Resolve fixture directory")
}
let directory = String(cString: resolved)
free(resolved)
let sourcePath = directory + "/source"
let spoolPath = directory + "/spool"
try manager.createDirectory(
  atPath: spoolPath, withIntermediateDirectories: false,
  attributes: [.posixPermissions: 0o700])
let root = try FileRoot(path: directory)
let spool = try FileRoot(path: spoolPath)
let bytes = Data((0..<180_000).map { UInt8($0 % 251) })
try bytes.write(to: URL(fileURLWithPath: sourcePath))
let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()

let savedURL = try await root.withSnapshot(path: sourcePath, spool: spool) { snapshot in
  try require(snapshot.size == bytes.count && snapshot.sha256 == digest, "Exact snapshot receipt")
  let captured = try Data(contentsOf: snapshot.url)
  try require(captured == bytes, "Exact captured bytes")
  var attributes = stat()
  guard lstat(snapshot.url.path, &attributes) == 0 else {
    throw FixtureFailure.failed("Snapshot stat")
  }
  try require(attributes.st_mode & 0o777 == 0o400, "Read-only private snapshot")
  let parent = snapshot.url.deletingLastPathComponent()
  guard lstat(parent.path, &attributes) == 0 else { throw FixtureFailure.failed("Directory stat") }
  try require(attributes.st_mode & 0o777 == 0o700, "Private snapshot directory")
  try Data("Changed original".utf8).write(to: URL(fileURLWithPath: sourcePath))
  try require(
    try Data(contentsOf: snapshot.url) == bytes, "Source edits cannot change captured bytes")
  return snapshot.url
}
try require(!manager.fileExists(atPath: savedURL.path), "Success removes snapshot")
try require(try manager.contentsOfDirectory(atPath: spoolPath).isEmpty, "Success removes directory")

do {
  _ = try await root.withSnapshot(path: sourcePath, spool: spool) { _ -> Bool in
    throw FixtureFailure.callback
  }
  throw FixtureFailure.failed("Callback error was swallowed")
} catch FixtureFailure.callback {}
try require(
  try manager.contentsOfDirectory(atPath: spoolPath).isEmpty, "Callback failure cleans up")

do {
  _ = try await root.withSnapshot(path: sourcePath, spool: spool, maximumBytes: 1) { _ in true }
  throw FixtureFailure.failed("Oversized source accepted")
} catch FileOperationError.sizeLimit {}
try require(try manager.contentsOfDirectory(atPath: spoolPath).isEmpty, "Read failure cleans up")

let started = AsyncStream<Void>.makeStream()
let cancellation = Task {
  try await root.withSnapshot(path: sourcePath, spool: spool) { _ in
    started.continuation.yield(())
    started.continuation.finish()
    try await Task.sleep(for: .seconds(30))
    return true
  }
}
for await _ in started.stream { break }
cancellation.cancel()
do {
  _ = try await cancellation.value
  throw FixtureFailure.failed("Cancellation accepted")
} catch is CancellationError {
} catch FileOperationError.canceled {}
try require(try manager.contentsOfDirectory(atPath: spoolPath).isEmpty, "Cancellation cleans up")

do {
  _ = try await root.withSnapshot(path: sourcePath, spool: spool, timeout: .leastNonzeroMagnitude) {
    _ in true
  }
  throw FixtureFailure.failed("Deadline accepted")
} catch FileOperationError.deadline {}
try require(try manager.contentsOfDirectory(atPath: spoolPath).isEmpty, "Deadline cleans up")

try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: spoolPath)
do {
  _ = try await root.withSnapshot(path: sourcePath, spool: spool) { _ in true }
  throw FixtureFailure.failed("Shared spool accepted")
} catch FileOperationError.permissionDenied(EACCES) {}
try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: spoolPath)

try Data().write(to: URL(fileURLWithPath: sourcePath))
let empty = try await root.withSnapshot(path: sourcePath, spool: spool, maximumBytes: 0) {
  snapshot in
  try require(snapshot.size == 0, "Empty-file snapshot")
  return snapshot.sha256
}
try require(
  empty == SHA256.hash(data: Data()).map { String(format: "%02x", $0) }.joined(), "Empty digest")

let operation: @Sendable () async throws -> String = {
  try await root.withSnapshot(path: sourcePath, spool: spool) { snapshot in
    try await Task.sleep(for: .milliseconds(30))
    return snapshot.url.path
  }
}
async let one = operation()
async let two = operation()
let (left, right) = try await (one, two)
try require(left != right, "Concurrent captures stay isolated")
try require(try manager.contentsOfDirectory(atPath: spoolPath).isEmpty, "All snapshots removed")

do {
  _ = try await root.withSnapshot(path: sourcePath, spool: spool) { snapshot in
    let extra = snapshot.url.deletingLastPathComponent().appendingPathComponent("unrelated")
    try Data("Do not silently remove".utf8).write(to: extra)
    return true
  }
  throw FixtureFailure.failed("Cleanup failure was hidden")
} catch FileOperationError.system(ENOTEMPTY) {}
let remaining = try manager.contentsOfDirectory(atPath: spoolPath)
try require(remaining.count == 1, "Failed cleanup retains evidence")
let retained = spoolPath + "/" + remaining[0]
try require(!manager.fileExists(atPath: retained + "/bytes"), "Owned snapshot bytes removed")
try require(manager.fileExists(atPath: retained + "/unrelated"), "Unrelated content is preserved")
print("Native file snapshot checks passed")
