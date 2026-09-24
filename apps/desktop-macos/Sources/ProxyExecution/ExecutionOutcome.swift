import ProxyJournal

public enum ExecutionRejection: Error, Equatable {
  case stopped
  case staleSession
  case unsupported
  case expired
  case busy
  case reconciliationRequired
  case invalidMessage
}

/// A handler must report cancellation only after its owned effects have stopped.
/// Throwing, including CancellationError, is treated as uncertainty rather than proof.
public enum ExecutionOutcome: Sendable {
  case succeeded(exitCode: Int64? = nil)
  case failed(exitCode: Int64? = nil)
  case canceled

  var state: JournalState {
    switch self {
    case .succeeded: .succeeded
    case .failed: .failed
    case .canceled: .canceled
    }
  }

  var exitCode: Int64? {
    switch self {
    case .succeeded(let code), .failed(let code): code
    case .canceled: nil
    }
  }
}
