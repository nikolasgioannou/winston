import Foundation
import ProxyCommands
import ProxyJournal
import WinstonDeviceProtocol
import WinstonDeviceTransport

actor ExecutionReplies {
  private let transport: DeviceTransport
  private let session: DeviceSession
  private let binding: ExecutionBinding
  private let correlationId: String
  private var sequence: Int64 = 0
  private var chunks = 0
  private var bytes = 0

  init(
    transport: DeviceTransport, session: DeviceSession, request: DeviceMessage,
    binding: ExecutionBinding
  ) {
    self.transport = transport
    self.session = session
    self.binding = binding
    correlationId = request.messageId
  }

  func running() async throws {
    try await send(.status(binding, sequence: next(), state: "running", exitCode: nil))
  }

  func output(_ stream: CommandOutput.Stream, _ text: String) async throws {
    let length = text.utf8.count
    guard chunks < 4096, bytes + length <= 3 * 1024 * 1024 else {
      throw DeviceTransportError.unavailable
    }
    chunks += 1
    bytes += length
    let name =
      switch stream {
      case .stdout: "stdout"
      case .stderr: "stderr"
      }
    try await send(.output(binding, sequence: next(), stream: name, text: text))
  }

  func finish(_ record: JournalRecord) async throws {
    guard [.succeeded, .failed, .canceled].contains(record.state) else {
      throw DeviceTransportError.unavailable
    }
    try await send(
      .status(
        binding, sequence: next(), state: record.state.rawValue,
        exitCode: record.exitCode))
  }

  private func next() -> Int64 {
    defer { sequence += 1 }
    return sequence
  }

  private func send(_ payload: DevicePayload) async throws {
    try await transport.send(payload, correlationId: correlationId, session: session)
  }
}
