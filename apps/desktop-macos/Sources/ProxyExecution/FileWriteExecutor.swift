import Foundation
import ProxyFileTransfer
import ProxyFiles
import WinstonDeviceProtocol

public struct FileWriteExecutor: Sendable {
  private let downloader: DeviceFileDownloader
  private let root: FileWriteRoot

  public init(downloader: DeviceFileDownloader, root: FileWriteRoot) {
    self.downloader = downloader
    self.root = root
  }

  public func execute(_ request: DeviceMessage, session: DeviceSession) async throws
    -> ExecutionOutcome
  {
    if Task.isCancelled { return .canceled }
    do {
      _ = try await downloader.write(request, session: session, root: root)
      return .succeeded()
    } catch let error as FileWriteError {
      switch error {
      case .publicationUncertain, .cleanupFailed: throw error
      default: return .failed()
      }
    } catch let error as FileOperationError {
      switch error {
      case .canceled, .deadline: return .canceled
      default: return .failed()
      }
    } catch let error as DeviceFileDownloadError {
      return error == .deadline ? .canceled : .failed()
    } catch is CancellationError {
      return .canceled
    } catch {
      // The downloader joins the writer and reports network errors only before
      // publication. Unknown publication/cleanup failures are preserved above.
      let network = error as NSError
      if network.domain == NSURLErrorDomain
        && [NSURLErrorCancelled, NSURLErrorTimedOut].contains(network.code)
      {
        return .canceled
      }
      return .failed()
    }
  }
}
