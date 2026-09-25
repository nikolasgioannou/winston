import ProxyExecution
import ProxyFileTransfer
import ProxyFiles

public struct FileWriteConfiguration: Sendable {
  private let downloader: DeviceFileDownloader
  private let root: FileWriteRoot

  public init(downloader: DeviceFileDownloader, root: FileWriteRoot) {
    self.downloader = downloader
    self.root = root
  }

  func executor() -> FileWriteExecutor {
    FileWriteExecutor(downloader: downloader, root: root)
  }
}
