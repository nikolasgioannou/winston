import Darwin
import Foundation
import ProxyExecution
import ProxyFileTransfer
import ProxyFiles
import ProxyJournal

public struct FileReadConfiguration: Sendable {
  private let uploader: DeviceFileUploader
  private let root: FileRoot

  public init(uploader: DeviceFileUploader, root: FileRoot) {
    self.uploader = uploader
    self.root = root
  }

  func executor(directory: URL) throws -> FileReadExecutor {
    let path = directory.appendingPathComponent("file-captures", isDirectory: true).path
    guard mkdir(path, 0o700) == 0 || errno == EEXIST else { throw JournalError.unavailable }
    let spool = try FileRoot(path: path)
    var attributes = stat()
    guard lstat(path, &attributes) == 0, attributes.st_uid == geteuid(),
      attributes.st_mode & 0o077 == 0
    else { throw JournalError.unavailable }
    return FileReadExecutor(uploader: uploader, root: root, spool: spool)
  }
}
