import CryptoKit
import Darwin
import Foundation

public enum FileCollisionPolicy: Sendable {
  case createOnly
  /// Explicitly authorizes replacing the directory entry with a new private regular file.
  /// Existing permissions, extended attributes and other hard links are not carried forward.
  case replace
}

public enum FileWriteError: Error, Equatable, Sendable {
  case invalidDigest
  case invalidChunk
  case contentMismatch
  case collision
  case cleanupFailed(Int32)
  /// Publication may have happened. Reconcile the destination; never blindly repeat a write.
  case publicationUncertain
}

public struct FileWriteReceipt: Sendable {
  public let size: Int64
  public let sha256: String
}

/// Construct only after a separate write grant. A read-only FileRoot exposes no write method.
public final class FileWriteRoot: Sendable {
  private let root: FileRoot

  public init(path: String) throws { root = try FileRoot(path: path) }

  /// The producer supplies at most 64 KiB per call and nil at EOF. Before publication,
  /// failure leaves the destination untouched and attempts temporary-file cleanup.
  /// Crash recovery must reconcile owned temporary files through the execution journal.
  /// Run off the UI thread; cancellation cannot interrupt a kernel-blocked system call.
  public func write(
    path: String, transferId: UUID, size: Int64, sha256: String,
    collision: FileCollisionPolicy = .createOnly,
    timeout: Double = 30, cancellation: FileCancellation = FileCancellation(),
    next: () throws -> Data?
  ) throws -> FileWriteReceipt {
    guard size >= 0, size <= 52_428_800 else { throw FileOperationError.invalidLimit }
    guard sha256.utf8.count == 64,
      sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else { throw FileWriteError.invalidDigest }
    guard try root.relative(path) != ".", let slash = path.lastIndex(of: "/") else {
      throw FileOperationError.invalidPath
    }
    let parentPath = slash == path.startIndex ? "/" : String(path[..<slash])
    let name = String(path[path.index(after: slash)...])
    let budget = try FileBudget(seconds: timeout, cancellation: cancellation)
    try budget.check()
    let parent = try root.open(parentPath, flags: O_RDONLY | O_DIRECTORY)
    defer { Darwin.close(parent) }
    try validateDestination(parent: parent, name: name, collision: collision)
    let temporary = ".winston-transfer-" + transferId.uuidString.lowercased()
    guard name != temporary else { throw FileOperationError.invalidPath }
    let file = openat(
      parent, temporary, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW_ANY, 0o600)
    guard file >= 0 else { throw FileOperationError.current() }
    defer { Darwin.close(file) }
    var published = false
    let result = Result { () throws -> FileWriteReceipt in
      var count: Int64 = 0
      var hash = SHA256()
      while true {
        try budget.check()
        guard let data = try next() else { break }
        try budget.check()
        guard !data.isEmpty, data.count <= 65_536 else { throw FileWriteError.invalidChunk }
        count += Int64(data.count)
        guard count <= size else { throw FileWriteError.contentMismatch }
        try data.withUnsafeBytes { buffer in
          var offset = 0
          while offset < buffer.count {
            try budget.check()
            let written = Darwin.write(
              file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            if written < 0 {
              if errno == EINTR { continue }
              throw FileOperationError.current()
            }
            guard written > 0 else { throw FileOperationError.system(EIO) }
            offset += written
          }
        }
        hash.update(data: data)
      }
      let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
      guard count == size, digest == sha256 else { throw FileWriteError.contentMismatch }
      try budget.check()
      guard fcntl(file, F_FULLFSYNC) == 0 else { throw FileOperationError.current() }
      let staged = try verifyStagedFile(file, size: size, sha256: sha256, budget: budget)
      var named = stat()
      guard fstatat(parent, temporary, &named, AT_SYMLINK_NOFOLLOW) == 0 else {
        throw FileOperationError.current()
      }
      guard sameFileVersion(staged, named), staged.st_size == size else {
        throw FileOperationError.changed
      }
      try validateDestination(parent: parent, name: name, collision: collision)
      try budget.check()
      let flags = UInt32(RENAME_NOFOLLOW_ANY | (collision == .createOnly ? RENAME_EXCL : 0))
      guard renameatx_np(parent, temporary, parent, name, flags) == 0 else {
        if errno == EEXIST { throw FileWriteError.collision }
        switch errno {
        case EACCES, EPERM, ENOENT, ENOTDIR, EISDIR, ENOTEMPTY, EXDEV, ELOOP, EINVAL,
          ENOTSUP, EROFS, ENAMETOOLONG:
          throw FileOperationError.current()
        default:
          // An I/O or transport error can leave publication uncertain on a remote volume.
          // Preserve both names for reconciliation instead of deleting potential evidence.
          published = true
          throw FileWriteError.publicationUncertain
        }
      }
      published = true
      // Once renamed, preserve the result even if cancellation arrives. A failed durability or
      // identity check is uncertain, not a promise that the original destination survived.
      guard fsync(parent) == 0, fcntl(file, F_FULLFSYNC) == 0,
        fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
        named.st_dev == staged.st_dev, named.st_ino == staged.st_ino,
        named.st_size == size, named.st_mode & S_IFMT == S_IFREG,
        named.st_mtimespec.tv_sec == staged.st_mtimespec.tv_sec,
        named.st_mtimespec.tv_nsec == staged.st_mtimespec.tv_nsec
      else { throw FileWriteError.publicationUncertain }
      return FileWriteReceipt(size: count, sha256: digest)
    }
    if !published, unlinkat(parent, temporary, 0) != 0, errno != ENOENT {
      throw FileWriteError.cleanupFailed(errno)
    }
    return try result.get()
  }
}

private func validateDestination(parent: Int32, name: String, collision: FileCollisionPolicy) throws
{
  var value = stat()
  if fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0 {
    if collision == .createOnly { throw FileWriteError.collision }
    guard value.st_mode & S_IFMT == S_IFREG else { throw FileOperationError.unsupportedType }
  } else if errno != ENOENT {
    throw FileOperationError.current()
  }
}
