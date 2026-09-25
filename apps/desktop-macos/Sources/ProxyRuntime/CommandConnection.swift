import Darwin
import Foundation
import ProxyJournal
import WinstonDeviceTransport

/// Keeps durable storage open until every connection-owned worker has stopped.
public struct CommandConnection: Sendable {
  private let directory: URL
  private let environment: [String: String]

  public init(directory: URL, environment: [String: String]) {
    self.directory = directory
    self.environment = environment
  }

  public func run(
    transport: DeviceTransport,
    onState: @escaping @Sendable (DeviceConnectionState) async -> Void,
    status: @escaping @Sendable () async -> DeviceAvailability
  ) async throws {
    try Task.checkCancellation()
    guard directory.isFileURL else { throw JournalError.unavailable }
    guard mkdir(directory.path, 0o700) == 0 || errno == EEXIST else {
      throw JournalError.unavailable
    }
    // Existing directories and files are validated, never chmodded or replaced.
    let journal = try ExecutionJournal(directory: directory)
    let runtime = CommandSession(journal: journal, environment: environment)
    do {
      try await DeviceConnectionLoop(transport: transport).run(
        onState: onState, status: status,
        handleSession: { session in
          try await runtime.run(
            transport: transport, session: session, ready: { await status() == .ready })
        })
    } catch {
      await journal.close()
      throw error
    }
    await journal.close()
  }
}
