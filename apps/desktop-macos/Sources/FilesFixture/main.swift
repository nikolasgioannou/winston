import CryptoKit
import Darwin
import Foundation
import ProxyFiles

enum FixtureFailure: Error {
  case failed(String)
  case consumer
}

func require(_ condition: @autoclosure () -> Bool, _ description: String) throws {
  if !condition() { throw FixtureFailure.failed(description) }
}

func rejects(_ expected: FileOperationError? = nil, _ body: () throws -> Void) throws {
  do {
    try body()
  } catch let error as FileOperationError {
    if let expected { try require(error == expected, "Expected \(expected), received \(error)") }
    return
  }
  throw FixtureFailure.failed("Operation unexpectedly succeeded")
}

let manager = FileManager.default
guard let resolved = realpath(CommandLine.arguments[1], nil) else {
  throw FixtureFailure.failed("Resolve fixture directory")
}
let directory = String(cString: resolved)
free(resolved)
let allowed = directory + "/allowed"
try manager.createDirectory(atPath: allowed, withIntermediateDirectories: true)
let root = try FileRoot(path: allowed)
let path = allowed + "/report.txt"
let data = Data((0..<180_000).map { UInt8($0 % 251) })
try data.write(to: URL(fileURLWithPath: path))
let metadata = try root.metadata(path: path)
try require(metadata.kind == .regular && metadata.size == data.count, "Regular-file metadata")
var result = Data()
var chunks = 0
let receipt = try root.read(path: path, maximumBytes: 200_000) { chunk in
  try require(chunk.count <= 65_536, "Bounded chunks")
  chunks += 1
  result.append(chunk)
}
let expectedHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
try require(result == data && chunks == 3, "Exact bytes and streaming")
try require(receipt.size == data.count && receipt.sha256 == expectedHash, "Verified receipt")
let empty = allowed + "/empty"
try Data().write(to: URL(fileURLWithPath: empty))
let emptyReceipt = try root.read(path: empty, maximumBytes: 0) { _ in
  throw FixtureFailure.failed("Empty file emitted bytes")
}
try require(emptyReceipt.size == 0, "Empty-file receipt")

try rejects(.invalidPath) { _ = try root.metadata(path: allowed + "/../outside") }
try rejects(.invalidPath) { _ = try root.metadata(path: allowed + "//report.txt") }
try rejects(.invalidPath) { _ = try root.metadata(path: allowed + "/./report.txt") }
try rejects(.invalidPath) { _ = try root.metadata(path: path + "\0") }
try rejects(.outsideRoot) { _ = try root.metadata(path: directory + "/allowed-other/report.txt") }
try rejects(.outsideRoot) { _ = try root.metadata(path: directory) }
let outside = directory + "/outside"
try Data("private".utf8).write(to: URL(fileURLWithPath: outside))
try manager.createSymbolicLink(atPath: allowed + "/link", withDestinationPath: outside)
try manager.createSymbolicLink(atPath: allowed + "/parent-link", withDestinationPath: directory)
try manager.createSymbolicLink(atPath: directory + "/root-link", withDestinationPath: allowed)
try rejects { _ = try FileRoot(path: directory + "/root-link") }
try rejects { _ = try root.metadata(path: allowed + "/link") }
try rejects {
  _ = try root.read(path: allowed + "/parent-link/outside", maximumBytes: 100) { _ in
    throw FixtureFailure.failed("Symlink leaked content")
  }
}
let listing = try root.list(path: allowed)
try require(!listing.truncated && listing.entries.count == 4, "Complete listing")
try require(
  listing.entries.first { $0.name == "link" }?.metadata.kind == .symbolicLink,
  "Listing describes links without following them")
let partial = try root.list(path: allowed, limit: 1)
try require(partial.truncated && partial.entries.count == 1, "Bounded listing")
let repeated = try root.list(path: allowed)
try require(repeated.entries.count == 4, "Independent directory offsets")
try rejects(.invalidLimit) { _ = try root.list(path: allowed, limit: 0) }
try rejects(.sizeLimit) {
  _ = try root.read(path: path, maximumBytes: 100) { _ in
    throw FixtureFailure.failed("Oversized file emitted bytes")
  }
}
try rejects(.unsupportedType) { _ = try root.read(path: allowed, maximumBytes: 200_000) { _ in } }
let pipe = allowed + "/pipe"
guard mkfifo(pipe, 0o600) == 0 else { throw FixtureFailure.failed("Create fixture FIFO") }
try rejects(.unsupportedType) { _ = try root.read(path: pipe, maximumBytes: 100) { _ in } }

let denied = allowed + "/denied"
try Data("inaccessible".utf8).write(to: URL(fileURLWithPath: denied))
guard chmod(denied, 0) == 0 else { throw FixtureFailure.failed("Remove fixture permissions") }
try rejects(.permissionDenied(EACCES)) {
  _ = try root.read(path: denied, maximumBytes: 100) { _ in }
}
guard chmod(denied, 0o600) == 0 else { throw FixtureFailure.failed("Restore fixture permissions") }

let cancellation = FileCancellation()
var canceledChunks = 0
try rejects(.canceled) {
  _ = try root.read(path: path, maximumBytes: 200_000, cancellation: cancellation) { _ in
    canceledChunks += 1
    cancellation.cancel()
  }
}
try require(canceledChunks == 1, "Canceled read stops at chunk boundary")
try rejects(.canceled) { _ = try root.list(path: allowed, cancellation: cancellation) }
try rejects(.deadline) {
  _ = try root.read(path: path, maximumBytes: 200_000, timeout: 0.01) { _ in
    Thread.sleep(forTimeInterval: 0.03)
  }
}
do {
  _ = try root.read(path: path, maximumBytes: 200_000) { _ in throw FixtureFailure.consumer }
  throw FixtureFailure.failed("Consumer failure was swallowed")
} catch FixtureFailure.consumer {}

var changed = false
try rejects(.changed) {
  _ = try root.read(path: path, maximumBytes: 200_000) { _ in
    if !changed {
      changed = true
      let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
      defer { try? handle.close() }
      try handle.write(contentsOf: Data([255]))
    }
  }
}
var replaced = false
try rejects(.changed) {
  _ = try root.read(path: path, maximumBytes: 200_000) { _ in
    if !replaced {
      replaced = true
      try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
  }
}
var grown = false
try rejects(.sizeLimit) {
  _ = try root.read(path: path, maximumBytes: Int64(data.count)) { _ in
    if !grown {
      grown = true
      let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
      defer { try? handle.close() }
      try handle.seekToEnd()
      try handle.write(contentsOf: Data([1]))
    }
  }
}
try rejects(.system(ENOENT)) { _ = try root.metadata(path: allowed + "/missing") }
let nested = allowed + "/nested"
try manager.createDirectory(atPath: nested, withIntermediateDirectories: false)
try data.write(to: URL(fileURLWithPath: nested + "/report.txt"))
let nestedReceipt = try root.read(path: nested + "/report.txt", maximumBytes: 200_000) { _ in }
try require(nestedReceipt.sha256 == expectedHash, "Nested directory read")
try manager.moveItem(atPath: allowed, toPath: directory + "/moved")
try manager.createDirectory(atPath: allowed, withIntermediateDirectories: false)
try Data("replacement root".utf8).write(to: URL(fileURLWithPath: allowed + "/empty"))
let anchored = try root.read(path: empty, maximumBytes: 0) { _ in }
try require(anchored.size == 0, "Grant follows opened directory, not a replacement at its path")
print("Native scoped file read checks passed")
