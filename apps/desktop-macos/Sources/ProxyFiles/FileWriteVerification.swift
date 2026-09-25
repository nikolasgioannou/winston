import CryptoKit
import Darwin
import Foundation

func verifyStagedFile(_ file: Int32, size: Int64, sha256: String, budget: FileBudget) throws -> stat
{
  let before = try fileStat(file)
  guard before.st_size == size else { throw FileWriteError.contentMismatch }
  guard lseek(file, 0, SEEK_SET) == 0 else { throw FileOperationError.current() }
  var bytes = [UInt8](repeating: 0, count: 65_536)
  var count: Int64 = 0
  var hash = SHA256()
  while true {
    try budget.check()
    let received = bytes.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
    if received < 0 {
      if errno == EINTR { continue }
      throw FileOperationError.current()
    }
    if received == 0 { break }
    count += Int64(received)
    guard count <= size else { throw FileWriteError.contentMismatch }
    hash.update(data: Data(bytes.prefix(received)))
  }
  try budget.check()
  guard count == size,
    hash.finalize().map({ String(format: "%02x", $0) }).joined() == sha256
  else { throw FileWriteError.contentMismatch }
  guard try sameFileVersion(before, fileStat(file)) else { throw FileOperationError.changed }
  return before
}
