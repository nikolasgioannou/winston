import CryptoKit
import Darwin
import Foundation

public struct FileSnapshot: Sendable {
  public let url: URL
  public let size: Int64
  public let sha256: String
}

extension FileRoot {
  /// The snapshot exists only during the callback. Its directory must be a private,
  /// caller-owned spool; the callback must finish using the file before returning.
  /// Timeout bounds capture and verification. The callback owns its network deadline.
  public func withSnapshot<Result: Sendable>(
    path: String, spool: FileRoot, maximumBytes: Int64 = 52_428_800,
    timeout: Double = 30,
    use: @escaping @Sendable (FileSnapshot) async throws -> Result
  ) async throws -> Result {
    let cancellation = FileCancellation()
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      let captured = try await Task.detached {
        try CapturedFile(
          root: self, path: path, spool: spool,
          maximumBytes: maximumBytes, timeout: timeout, cancellation: cancellation)
      }.value
      do {
        try Task.checkCancellation()
        let result = try await use(captured.snapshot)
        try Task.checkCancellation()
        try captured.remove()
        return result
      } catch {
        try captured.remove()
        throw error
      }
    } onCancel: {
      cancellation.cancel()
    }
  }
}

private final class CapturedFile: Sendable {
  let snapshot: FileSnapshot
  private let spool: FileRoot
  private let directory: FileRoot
  private let name: String
  private let fileIdentity: stat
  private let directoryIdentity: stat

  init(
    root: FileRoot, path: String, spool: FileRoot,
    maximumBytes: Int64, timeout: Double, cancellation: FileCancellation
  ) throws {
    let budget = try FileBudget(seconds: timeout, cancellation: cancellation)
    try budget.check()
    let parent = try fileStat(spool.descriptor)
    guard parent.st_uid == geteuid(), parent.st_mode & 0o077 == 0 else {
      throw FileOperationError.permissionDenied(EACCES)
    }
    let name = ".winston-capture-" + UUID().uuidString.lowercased()
    guard mkdirat(spool.descriptor, name, 0o700) == 0 else {
      throw FileOperationError.current()
    }
    let directory: FileRoot
    do {
      directory = try FileRoot(path: spool.path + "/" + name)
      var created = stat()
      guard fstatat(spool.descriptor, name, &created, AT_SYMLINK_NOFOLLOW) == 0 else {
        throw FileOperationError.current()
      }
      let opened = try fileStat(directory.descriptor)
      guard created.st_dev == opened.st_dev, created.st_ino == opened.st_ino else {
        throw FileOperationError.changed
      }
    } catch {
      _ = unlinkat(spool.descriptor, name, AT_REMOVEDIR)
      throw error
    }
    let descriptor = openat(
      directory.descriptor, "bytes", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW_ANY, 0o600)
    guard descriptor >= 0 else {
      let error = FileOperationError.current()
      _ = unlinkat(spool.descriptor, name, AT_REMOVEDIR)
      throw error
    }
    defer { Darwin.close(descriptor) }
    do {
      let receipt = try root.read(
        path: path, maximumBytes: maximumBytes,
        timeout: timeout, cancellation: cancellation
      ) { chunk in
        try chunk.withUnsafeBytes { buffer in
          var offset = 0
          while offset < buffer.count {
            try budget.check()
            let count = Darwin.write(
              descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            if count < 0 {
              if errno == EINTR { continue }
              throw FileOperationError.current()
            }
            guard count > 0 else { throw FileOperationError.system(EIO) }
            offset += count
          }
        }
      }
      try budget.check()
      guard lseek(descriptor, 0, SEEK_SET) == 0 else { throw FileOperationError.current() }
      var hash = SHA256()
      var size: Int64 = 0
      var buffer = [UInt8](repeating: 0, count: 65_536)
      while true {
        try budget.check()
        let count = buffer.withUnsafeMutableBytes {
          Darwin.read(descriptor, $0.baseAddress, $0.count)
        }
        if count < 0 && errno == EINTR { continue }
        guard count >= 0 else { throw FileOperationError.current() }
        if count == 0 { break }
        size += Int64(count)
        guard size <= maximumBytes else { throw FileOperationError.sizeLimit }
        hash.update(data: Data(buffer.prefix(count)))
      }
      let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
      guard size == receipt.size, digest == receipt.sha256 else { throw FileOperationError.changed }
      guard fchmod(descriptor, 0o400) == 0 else { throw FileOperationError.current() }
      try budget.check()
      self.fileIdentity = try fileStat(descriptor)
      self.directoryIdentity = try fileStat(directory.descriptor)
      self.spool = spool
      self.directory = directory
      self.name = name
      snapshot = FileSnapshot(
        url: URL(fileURLWithPath: directory.path + "/bytes"), size: size, sha256: digest)
    } catch {
      guard unlinkat(directory.descriptor, "bytes", 0) == 0,
        unlinkat(spool.descriptor, name, AT_REMOVEDIR) == 0
      else { throw FileOperationError.current() }
      throw error
    }
  }

  func remove() throws {
    var file = stat()
    if fstatat(directory.descriptor, "bytes", &file, AT_SYMLINK_NOFOLLOW) == 0 {
      guard file.st_dev == fileIdentity.st_dev, file.st_ino == fileIdentity.st_ino else {
        throw FileOperationError.changed
      }
      guard unlinkat(directory.descriptor, "bytes", 0) == 0 else {
        throw FileOperationError.current()
      }
    } else if errno != ENOENT {
      throw FileOperationError.current()
    }
    var child = stat()
    if fstatat(spool.descriptor, name, &child, AT_SYMLINK_NOFOLLOW) == 0 {
      guard child.st_dev == directoryIdentity.st_dev, child.st_ino == directoryIdentity.st_ino
      else {
        throw FileOperationError.changed
      }
      guard unlinkat(spool.descriptor, name, AT_REMOVEDIR) == 0 else {
        throw FileOperationError.current()
      }
    } else if errno != ENOENT {
      throw FileOperationError.current()
    }
  }
}
