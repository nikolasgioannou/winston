import Darwin
import Foundation

/// A trusted, explicitly granted directory. Call blocking operations on a worker queue.
/// The grant follows the opened directory identity if it is renamed. Symlinks are never followed.
public final class FileRoot: Sendable {
  let descriptor: Int32
  public let path: String

  public init(path: String) throws {
    try Self.validate(path)
    let descriptor = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY)
    guard descriptor >= 0 else { throw FileOperationError.current() }
    self.descriptor = descriptor
    self.path = path
  }

  deinit { Darwin.close(descriptor) }

  static func validate(_ path: String) throws {
    guard path.hasPrefix("/"), !path.utf8.contains(0), path.utf8.count < Int(PATH_MAX) else {
      throw FileOperationError.invalidPath
    }
    if path == "/" { return }
    let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
    guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
      throw FileOperationError.invalidPath
    }
  }

  func relative(_ requested: String) throws -> String {
    try Self.validate(requested)
    if requested == path { return "." }
    let prefix = path == "/" ? "/" : path + "/"
    guard requested.hasPrefix(prefix) else { throw FileOperationError.outsideRoot }
    return String(requested.dropFirst(prefix.count))
  }

  func open(_ requested: String, flags: Int32) throws -> Int32 {
    let relative = try relative(requested)
    let result = openat(descriptor, relative, flags | O_CLOEXEC | O_NOFOLLOW_ANY | O_NONBLOCK)
    guard result >= 0 else { throw FileOperationError.current() }
    return result
  }

  public func metadata(path: String) throws -> FileMetadata {
    let file = try open(path, flags: O_EVTONLY)
    defer { Darwin.close(file) }
    return try FileMetadata(fileStat(file))
  }

  public func list(
    path: String, limit: Int = 200, timeout: Double = 10,
    cancellation: FileCancellation = FileCancellation()
  ) throws -> FileListing {
    guard limit > 0, limit <= 10_000 else { throw FileOperationError.invalidLimit }
    let budget = try FileBudget(seconds: timeout, cancellation: cancellation)
    try budget.check()
    let file = try open(path, flags: O_RDONLY | O_DIRECTORY)
    guard let directory = fdopendir(file) else {
      let error = FileOperationError.current()
      Darwin.close(file)
      throw error
    }
    defer { closedir(directory) }
    let before = try fileStat(file)
    var entries: [FileEntry] = []
    var truncated = false
    while true {
      try budget.check()
      errno = 0
      guard let entry = readdir(directory) else {
        if errno != 0 { throw FileOperationError.current() }
        break
      }
      let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) {
          String(validatingCString: $0)
        }
      }
      guard let name else { throw FileOperationError.invalidPath }
      if name == "." || name == ".." { continue }
      if entries.count == limit {
        truncated = true
        break
      }
      var value = stat()
      guard fstatat(file, name, &value, AT_SYMLINK_NOFOLLOW) == 0 else {
        throw FileOperationError.current()
      }
      entries.append(FileEntry(name: name, metadata: FileMetadata(value)))
    }
    try budget.check()
    guard try sameFileVersion(before, fileStat(file)) else { throw FileOperationError.changed }
    return FileListing(entries: entries.sorted { $0.name < $1.name }, truncated: truncated)
  }
}
