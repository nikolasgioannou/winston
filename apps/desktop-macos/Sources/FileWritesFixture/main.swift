import CryptoKit
import Darwin
import Foundation
import ProxyFiles

enum FixtureFailure: Error {
  case failed(String)
  case producer
}

func require(_ condition: @autoclosure () -> Bool, _ description: String) throws {
  if !condition() { throw FixtureFailure.failed(description) }
}

func rejected(_ expected: FileWriteError, _ body: () throws -> Void) throws {
  do { try body() } catch let error as FileWriteError {
    try require(error == expected, "Expected \(expected), received \(error)")
    return
  }
  throw FixtureFailure.failed("Write unexpectedly succeeded")
}

func fileRejected(_ expected: FileOperationError, _ body: () throws -> Void) throws {
  do { try body() } catch let error as FileOperationError {
    try require(error == expected, "Expected \(expected), received \(error)")
    return
  }
  throw FixtureFailure.failed("Write unexpectedly succeeded")
}

let manager = FileManager.default
guard let resolved = realpath(CommandLine.arguments[1], nil) else {
  throw FixtureFailure.failed("Resolve fixture directory")
}
let directory = String(cString: resolved)
free(resolved)
let root = try FileWriteRoot(path: directory)
let data = Data("verified file contents".utf8)
let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
let path = directory + "/result.txt"

func publish(_ path: String, collision: FileCollisionPolicy = .createOnly) throws
  -> FileWriteReceipt
{
  var sent = false
  return try root.write(
    path: path, transferId: UUID(), size: Int64(data.count), sha256: digest, collision: collision
  ) {
    if sent { return nil }
    sent = true
    return data
  }
}

if CommandLine.arguments.last == "lost-receipt" {
  _ = try publish(path)
  // Model loss of the process before it can persist or transmit the returned receipt.
  _exit(23)
}
if CommandLine.arguments.last == "retry" {
  try rejected(.collision) { _ = try publish(path) }
  print("Lost receipt did not permit duplicate publication")
  exit(0)
}

let receipt = try publish(path)
let saved = try Data(contentsOf: URL(fileURLWithPath: path))
try require(
  saved == data && receipt.sha256 == digest && receipt.size == data.count, "Published bytes")
let attributes = try manager.attributesOfItem(atPath: path)
try require((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "Private permissions")
try rejected(.collision) { _ = try publish(path) }
try manager.linkItem(atPath: path, toPath: directory + "/original-link")
try Data("old".utf8).write(to: URL(fileURLWithPath: path))
_ = try publish(path, collision: .replace)
let oldLink = try Data(contentsOf: URL(fileURLWithPath: directory + "/original-link"))
try require(oldLink == Data("old".utf8), "Replacing one entry preserves other hard links")

let failed = directory + "/failed.txt"
let modifiedId = UUID()
var modifyAfterChunk = false
try rejected(.contentMismatch) {
  _ = try root.write(
    path: failed, transferId: modifiedId, size: Int64(data.count), sha256: digest
  ) {
    if !modifyAfterChunk {
      modifyAfterChunk = true
      return data
    }
    let staging = directory + "/.winston-transfer-" + modifiedId.uuidString.lowercased()
    let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: staging))
    defer { try? handle.close() }
    try handle.write(contentsOf: Data([255]))
    return nil
  }
}
let unfinishedId = UUID()
let unfinished = directory + "/.winston-transfer-" + unfinishedId.uuidString.lowercased()
try Data("unfinished".utf8).write(to: URL(fileURLWithPath: unfinished))
try fileRejected(.system(EEXIST)) {
  _ = try root.write(
    path: failed, transferId: unfinishedId, size: Int64(data.count), sha256: digest
  ) { data }
}
let unfinishedBytes = try Data(contentsOf: URL(fileURLWithPath: unfinished))
try require(
  unfinishedBytes == Data("unfinished".utf8), "Prior staging file requires reconciliation")
try manager.removeItem(atPath: unfinished)
try fileRejected(.invalidPath) {
  _ = try root.write(
    path: unfinished, transferId: unfinishedId, size: Int64(data.count), sha256: digest
  ) { data }
}
try require(!manager.fileExists(atPath: unfinished), "Destination cannot alias the staging file")
try rejected(.contentMismatch) {
  _ = try root.write(path: failed, transferId: UUID(), size: 1, sha256: digest) { data }
}
try rejected(.contentMismatch) {
  _ = try root.write(path: failed, transferId: UUID(), size: Int64(data.count), sha256: digest) {
    nil
  }
}
try rejected(.contentMismatch) {
  var sent = false
  _ = try root.write(
    path: failed, transferId: UUID(), size: Int64(data.count),
    sha256: String(repeating: "0", count: 64)
  ) {
    defer { sent = true }
    return sent ? nil : data
  }
}
try rejected(.invalidChunk) {
  _ = try root.write(path: failed, transferId: UUID(), size: 100_000, sha256: digest) {
    Data(repeating: 1, count: 65_537)
  }
}
try rejected(.invalidChunk) {
  _ = try root.write(path: failed, transferId: UUID(), size: 1, sha256: digest) { Data() }
}
try rejected(.invalidDigest) {
  _ = try root.write(path: failed, transferId: UUID(), size: 1, sha256: "bad") { data }
}
let cancellation = FileCancellation()
try fileRejected(.canceled) {
  _ = try root.write(
    path: failed, transferId: UUID(), size: Int64(data.count), sha256: digest,
    cancellation: cancellation
  ) {
    cancellation.cancel()
    return data
  }
}
try fileRejected(.deadline) {
  _ = try root.write(
    path: failed, transferId: UUID(), size: Int64(data.count), sha256: digest, timeout: 0.01
  ) {
    Thread.sleep(forTimeInterval: 0.03)
    return data
  }
}
do {
  _ = try root.write(path: failed, transferId: UUID(), size: Int64(data.count), sha256: digest) {
    throw FixtureFailure.producer
  }
  throw FixtureFailure.failed("Producer failure swallowed")
} catch FixtureFailure.producer {}
try require(!manager.fileExists(atPath: failed), "Failed writes never publish destination")
let afterFailures = try manager.contentsOfDirectory(atPath: directory)
try require(
  !afterFailures.contains { $0.hasPrefix(".winston-transfer-") }, "Temporary files cleaned")
let cleanupDirectory = directory + "/cleanup"
try manager.createDirectory(atPath: cleanupDirectory, withIntermediateDirectories: false)
let cleanupId = UUID()
try rejected(.cleanupFailed(EACCES)) {
  _ = try root.write(
    path: cleanupDirectory + "/result.txt", transferId: cleanupId,
    size: Int64(data.count), sha256: digest
  ) {
    guard chmod(cleanupDirectory, 0o500) == 0 else {
      throw FixtureFailure.failed("Deny temporary-file cleanup")
    }
    return nil
  }
}
guard chmod(cleanupDirectory, 0o700) == 0 else {
  throw FixtureFailure.failed("Restore cleanup directory permissions")
}
try require(
  !manager.fileExists(atPath: cleanupDirectory + "/result.txt"),
  "Cleanup failure does not publish a destination")
try manager.removeItem(
  atPath: cleanupDirectory + "/.winston-transfer-" + cleanupId.uuidString.lowercased())
try fileRejected(.outsideRoot) { _ = try publish(directory + "-outside/result.txt") }
try fileRejected(.invalidPath) { _ = try publish(directory + "/../result.txt") }
let folder = directory + "/folder"
try manager.createDirectory(atPath: folder, withIntermediateDirectories: false)
try fileRejected(.unsupportedType) { _ = try publish(folder, collision: .replace) }
let denied = directory + "/denied"
try manager.createDirectory(atPath: denied, withIntermediateDirectories: false)
guard chmod(denied, 0o500) == 0 else { throw FixtureFailure.failed("Deny writes") }
try fileRejected(.permissionDenied(EACCES)) { _ = try publish(denied + "/file.txt") }
guard chmod(denied, 0o700) == 0 else { throw FixtureFailure.failed("Restore fixture permissions") }
try manager.createSymbolicLink(atPath: directory + "/linked-folder", withDestinationPath: folder)
try fileRejected(.system(ELOOP)) { _ = try publish(directory + "/linked-folder/result.txt") }
try manager.createSymbolicLink(atPath: directory + "/linked-file", withDestinationPath: path)
try fileRejected(.unsupportedType) {
  _ = try publish(directory + "/linked-file", collision: .replace)
}

let race = directory + "/race.txt"
var raced = false
try rejected(.collision) {
  _ = try root.write(path: race, transferId: UUID(), size: Int64(data.count), sha256: digest) {
    if raced { return nil }
    raced = true
    try Data("other writer".utf8).write(to: URL(fileURLWithPath: race))
    return data
  }
}
let raceData = try Data(contentsOf: URL(fileURLWithPath: race))
try require(raceData == Data("other writer".utf8), "Concurrent destination preserved")
let emptyDigest = SHA256.hash(data: Data()).map { String(format: "%02x", $0) }.joined()
_ = try root.write(path: directory + "/empty", transferId: UUID(), size: 0, sha256: emptyDigest) {
  nil
}
let large = Data((0..<180_000).map { UInt8($0 % 251) })
let largeHash = SHA256.hash(data: large).map { String(format: "%02x", $0) }.joined()
var offset = 0
let largeReceipt = try root.write(
  path: directory + "/large", transferId: UUID(), size: Int64(large.count), sha256: largeHash
) {
  guard offset < large.count else { return nil }
  let end = min(offset + 65_536, large.count)
  defer { offset = end }
  return large.subdata(in: offset..<end)
}
let largeSaved = try Data(contentsOf: URL(fileURLWithPath: directory + "/large"))
try require(
  largeSaved == large && largeReceipt.sha256 == largeHash, "Multiple chunks preserve bytes")
print("Native verified file write checks passed")
