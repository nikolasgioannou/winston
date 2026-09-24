import Darwin
import Foundation
import ProxyCommands
import WinstonDeviceProtocol

public enum CommandExecutionError: Error, Sendable {
  case uncertain
}

public struct CommandExecutor: Sendable {
  private let environment: [String: String]

  public init(environment: [String: String]) {
    self.environment = environment
  }

  public func execute(
    _ operation: DeviceOperation, deadline: Int64, outputLimit: Int = 1_048_576,
    output: @escaping @Sendable (CommandOutput.Stream, String) async throws -> Void
  ) async throws -> ExecutionOutcome {
    if Task.isCancelled { return .canceled }
    guard case .command(let executable, let arguments, let directory) = operation else {
      return .failed()
    }
    do {
      let command = try Command(
        executable: executable, arguments: arguments, directory: directory,
        environment: environment, deadline: Date(timeIntervalSince1970: Double(deadline) / 1000))
      let execution = try CommandExecution(command: command, outputLimit: outputLimit)
      return try await withTaskCancellationHandler {
        var stdout = CommandTextDecoder()
        var stderr = CommandTextDecoder()
        do {
          for await chunk in execution.output {
            if Task.isCancelled {
              execution.cancel()
              break
            }
            let text: String
            switch chunk.stream {
            case .stdout: text = stdout.append(chunk.bytes)
            case .stderr: text = stderr.append(chunk.bytes)
            }
            if !text.isEmpty { try await output(chunk.stream, text) }
          }
          if !Task.isCancelled {
            let finalOut = stdout.append(Data(), final: true)
            let finalError = stderr.append(Data(), final: true)
            if !finalOut.isEmpty { try await output(.stdout, finalOut) }
            if !finalError.isEmpty { try await output(.stderr, finalError) }
          }
        } catch {
          // Output delivery failure stops the owned process. It is not itself
          // proof of cancellation; keep waiting for the runner's actual result.
          execution.cancel()
        }
        let result = try await execution.result()
        guard !result.uncertain else { throw CommandExecutionError.uncertain }
        switch result.stopReason {
        case .canceled, .deadline: return .canceled
        case .outputLimit, .outputClosed, .ioFailure:
          return .failed(exitCode: result.exitCode.map(Int64.init))
        case nil:
          return result.exitCode == 0
            ? .succeeded(exitCode: 0) : .failed(exitCode: result.exitCode.map(Int64.init))
        }
      } onCancel: {
        execution.cancel()
      }
    } catch let error as CommandError {
      // These typed errors arise during validation/spawn, before an effect starts.
      // Post-launch uncertainty uses a different error and remains fail-closed.
      let detail: String
      switch error {
      case .invalidConfiguration: detail = "Invalid command configuration."
      case .system(let code):
        detail = "Could not start command: \(String(cString: strerror(code)))."
      }
      if !Task.isCancelled { try? await output(.stderr, detail + "\n") }
      return .failed()
    }
  }
}
