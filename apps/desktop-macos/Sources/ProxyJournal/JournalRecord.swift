import Foundation

public enum JournalError: Error, Equatable {
  case unavailable
  case alreadyOpen
  case invalidRequest
  case conflictingExecution
  case invalidTransition
}

public enum JournalState: String, Sendable {
  case running
  case cancelRequested = "cancel_requested"
  case uncertain
  case succeeded
  case failed
  case canceled

  var isTerminal: Bool {
    self == .succeeded || self == .failed || self == .canceled
  }
}

public struct JournalKey: Sendable, Hashable {
  public let deviceId: String
  public let executionId: String

  public init(deviceId: String, executionId: String) throws {
    guard let device = UUID(uuidString: deviceId), let execution = UUID(uuidString: executionId)
    else {
      throw JournalError.invalidRequest
    }
    self.deviceId = device.uuidString.lowercased()
    self.executionId = execution.uuidString.lowercased()
  }
}

public struct JournalRecord: Sendable, Equatable {
  public let key: JournalKey
  public let fingerprint: String
  public let state: JournalState
  public let cancellationRequested: Bool
  public let exitCode: Int64?
}

public enum JournalAdmission: Sendable, Equatable {
  /// Only this result authorizes a caller to start an effect, after its policy checks.
  case admitted(JournalRecord)
  case existing(JournalRecord)
}
