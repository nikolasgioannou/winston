import CryptoKit
import Darwin
import Foundation

extension FileRoot {
  /// Chunks are provisional until the receipt returns. Consumers must stage, then publish.
  /// Cancellation and deadlines are checked between system calls and consumer callbacks;
  /// they cannot interrupt a filesystem syscall blocked in the kernel.
  public func read(
    path: String, maximumBytes: Int64, timeout: Double = 30,
    cancellation: FileCancellation = FileCancellation(),
    consume: (Data) throws -> Void
  ) throws -> FileReadReceipt {
    guard maximumBytes >= 0, maximumBytes <= 52_428_800 else {
      throw FileOperationError.invalidLimit
    }
    let budget = try FileBudget(seconds: timeout, cancellation: cancellation)
    try budget.check()
    let file = try open(path, flags: O_RDONLY)
    defer { Darwin.close(file) }
    let before = try fileStat(file)
    guard before.st_mode & S_IFMT == S_IFREG else { throw FileOperationError.unsupportedType }
    guard before.st_size >= 0, before.st_size <= maximumBytes else {
      throw FileOperationError.sizeLimit
    }
    var buffer = [UInt8](repeating: 0, count: 65_536)
    var count: Int64 = 0
    var hash = SHA256()
    while true {
      try budget.check()
      let received = buffer.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
      if received < 0 {
        if errno == EINTR { continue }
        throw FileOperationError.current()
      }
      if received == 0 { break }
      count += Int64(received)
      guard count <= maximumBytes else { throw FileOperationError.sizeLimit }
      let data = Data(buffer.prefix(received))
      hash.update(data: data)
      try budget.check()
      try consume(data)
    }
    try budget.check()
    guard count == before.st_size, try sameFileVersion(before, fileStat(file)) else {
      throw FileOperationError.changed
    }
    let current = try open(path, flags: O_EVTONLY)
    defer { Darwin.close(current) }
    guard try sameFileVersion(before, fileStat(current)) else { throw FileOperationError.changed }
    return FileReadReceipt(
      size: count, sha256: hash.finalize().map { String(format: "%02x", $0) }.joined())
  }
}
