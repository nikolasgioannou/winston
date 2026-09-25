import ProxyFileTransfer
import ProxyFiles
import WinstonDeviceProtocol

public struct FileReadExecutor: Sendable {
  private let uploader: DeviceFileUploader
  private let root: FileRoot
  private let spool: FileRoot

  public init(uploader: DeviceFileUploader, root: FileRoot, spool: FileRoot) {
    self.uploader = uploader
    self.root = root
    self.spool = spool
  }

  public func execute(_ request: DeviceMessage, session: DeviceSession) async throws
    -> ExecutionOutcome
  {
    if Task.isCancelled { return .canceled }
    do {
      _ = try await uploader.capture(request, session: session, root: root, spool: spool)
      return .succeeded()
    } catch let error as DeviceFileUploadError {
      // Missing acknowledgments may represent a completed remote upload. Keep
      // them uncertain so reconnects cannot repeat this execution silently.
      if error == .uncertain { throw error }
      if error == .deadline { return .canceled }
      return .failed()
    } catch let error as FileOperationError {
      switch error {
      case .canceled, .deadline: return .canceled
      default: return .failed()
      }
    }
    // CancellationError may arrive after upload began, so it is not evidence
    // that the server failed to receive the file. The coordinator records uncertainty.
  }
}
