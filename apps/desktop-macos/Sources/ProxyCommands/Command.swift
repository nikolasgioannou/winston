import Foundation

public struct Command: Sendable {
  public let executable: String
  public let arguments: [String]
  public let directory: String
  public let environment: [String: String]
  public let deadline: Date

  public init(
    executable: String, arguments: [String], directory: String,
    environment: [String: String], deadline: Date
  ) throws {
    guard executable.hasPrefix("/"), directory.hasPrefix("/"), arguments.count <= 128,
      environment.count <= 128, deadline.timeIntervalSince1970.isFinite,
      [executable, directory].allSatisfy({ !$0.utf8.contains(0) && $0.utf8.count <= 4096 }),
      arguments.allSatisfy({ !$0.utf8.contains(0) && $0.utf8.count <= 8192 }),
      environment.allSatisfy({ key, value in
        !key.isEmpty && !key.contains("=") && !key.utf8.contains(0) && !value.utf8.contains(0)
          && key.utf8.count <= 255 && value.utf8.count <= 8192
      })
    else { throw CommandError.invalidConfiguration }
    self.executable = executable
    self.arguments = arguments
    self.directory = directory
    self.environment = environment
    self.deadline = deadline
  }
}

public enum CommandError: Error, Sendable {
  case invalidConfiguration
  case system(Int32)
}

public struct CommandOutput: Sendable {
  public enum Stream: Sendable { case stdout, stderr }
  public let stream: Stream
  public let bytes: Data
}

public struct CommandResult: Sendable {
  public enum StopReason: Sendable { case canceled, deadline, outputLimit, outputClosed, ioFailure }
  public let exitCode: Int32?
  public let signal: Int32?
  public let stopReason: StopReason?
  /// Failure to confirm process-group cleanup must keep execution reconciliation blocked.
  public let uncertain: Bool
}

final class CommandCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var requested = false

  func cancel() {
    lock.lock()
    requested = true
    lock.unlock()
  }

  var isCanceled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return requested
  }
}

/// The monitor runs on a dedicated queue; a stalled output consumer cannot block stop.
public final class CommandExecution: Sendable {
  public let output: AsyncStream<CommandOutput>
  private let cancellation: CommandCancellation
  private let completion: Task<CommandResult, Error>

  public init(command: Command, outputLimit: Int = 1_048_576) throws {
    guard outputLimit > 0 && outputLimit <= 16_777_216 else {
      throw CommandError.invalidConfiguration
    }
    let cancellation = CommandCancellation()
    self.cancellation = cancellation
    let stream = AsyncStream<CommandOutput>.makeStream(bufferingPolicy: .bufferingOldest(16))
    output = stream.stream
    stream.continuation.onTermination = { _ in cancellation.cancel() }
    completion = Task {
      try await withCheckedThrowingContinuation { continuation in
        DispatchQueue(label: "app.runwinston.command", qos: .utility).async {
          defer { stream.continuation.finish() }
          do {
            let result = try monitor(
              command: command, cancellation: cancellation,
              output: stream.continuation, outputLimit: outputLimit)
            continuation.resume(returning: result)
          } catch { continuation.resume(throwing: error) }
        }
      }
    }
  }

  public func cancel() { cancellation.cancel() }

  deinit { cancellation.cancel() }

  public func result() async throws -> CommandResult {
    try await withTaskCancellationHandler {
      try await completion.value
    } onCancel: {
      self.cancellation.cancel()
    }
  }
}
