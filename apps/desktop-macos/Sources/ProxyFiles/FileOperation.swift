import Darwin
import Foundation

public enum FileOperationError: Error, Equatable, Sendable {
  case invalidPath
  case outsideRoot
  case invalidLimit
  case unsupportedType
  case sizeLimit
  case changed
  case canceled
  case deadline
  case permissionDenied(Int32)
  case system(Int32)

  static func current() -> Self {
    let code = errno
    return code == EACCES || code == EPERM ? .permissionDenied(code) : .system(code)
  }
}

public final class FileCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var canceled = false

  public init() {}

  public func cancel() {
    lock.lock()
    canceled = true
    lock.unlock()
  }

  func check() throws {
    lock.lock()
    defer { lock.unlock() }
    if canceled { throw FileOperationError.canceled }
  }
}

struct FileBudget {
  let cancellation: FileCancellation
  let deadline: ContinuousClock.Instant

  init(seconds: Double, cancellation: FileCancellation) throws {
    guard seconds.isFinite, seconds > 0, seconds <= 300 else {
      throw FileOperationError.invalidLimit
    }
    self.cancellation = cancellation
    deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
  }

  func check() throws {
    try cancellation.check()
    if ContinuousClock.now >= deadline { throw FileOperationError.deadline }
  }
}

public struct FileMetadata: Sendable {
  public enum Kind: Sendable { case regular, directory, symbolicLink, other }
  public let kind: Kind
  public let size: Int64
  public let modifiedAt: Date

  init(_ value: stat) {
    switch value.st_mode & S_IFMT {
    case S_IFREG: kind = .regular
    case S_IFDIR: kind = .directory
    case S_IFLNK: kind = .symbolicLink
    default: kind = .other
    }
    size = value.st_size
    modifiedAt = Date(
      timeIntervalSince1970: Double(value.st_mtimespec.tv_sec)
        + Double(value.st_mtimespec.tv_nsec) / 1_000_000_000)
  }
}

public struct FileEntry: Sendable {
  public let name: String
  public let metadata: FileMetadata
}

public struct FileListing: Sendable {
  public let entries: [FileEntry]
  public let truncated: Bool
}

public struct FileReadReceipt: Sendable {
  public let size: Int64
  public let sha256: String
}

func fileStat(_ descriptor: Int32) throws -> stat {
  var value = stat()
  guard fstat(descriptor, &value) == 0 else { throw FileOperationError.current() }
  return value
}

func sameFileVersion(_ left: stat, _ right: stat) -> Bool {
  left.st_dev == right.st_dev && left.st_ino == right.st_ino
    && left.st_mode == right.st_mode && left.st_size == right.st_size
    && left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec
    && left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec
    && left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec
    && left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec
}
