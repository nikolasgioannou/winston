import Foundation
import WinstonDeviceProtocol
import WinstonDeviceTransport

private func rejected(_ operation: @Sendable () async throws -> Void) async throws {
  do {
    try await operation()
    fatalError("Closed or obsolete channel accepted work")
  } catch is DeviceTransportError {
  } catch is CancellationError {}
}

@main
struct DuplexFixture {
  static func main() async throws {
    let transport = try DeviceTransport(
      endpoint: URL(string: CommandLine.arguments[1])!,
      deviceId: "11111111-1111-4111-8111-111111111111",
      credential: "wdi_" + String(repeating: "a", count: 43), allowInsecureLoopback: true)
    let mode = CommandLine.arguments[2]
    let session = try await transport.connect()
    switch mode {
    case "reconcile":
      let request = try await transport.receiveOperation(session: session)
      guard case .reconcile(let binding, _) = request.payload else {
        fatalError("Journal query was not delivered")
      }
      try await rejected {
        try await transport.send(
          request.payload, correlationId: request.messageId, session: session)
      }
      try await transport.send(
        .reconciled(binding, state: "uncertain", exitCode: nil),
        correlationId: request.messageId, session: session)
      try await transport.waitForDisconnect(session: session)
    case "duplex", "idle":
      let heartbeat = Task {
        if mode == "duplex" { try await transport.heartbeat(status: "ready") }
      }
      let execute = try await transport.receiveOperation(session: session)
      guard case .execute(let binding, _, _) = execute.payload else {
        fatalError("Execute was not delivered first")
      }
      let cancel = try await transport.receiveOperation(session: session)
      guard case .cancel(let canceled) = cancel.payload,
        canceled.executionId == binding.executionId
      else { fatalError("Cancellation was not delivered second") }
      try await heartbeat.value
      try await transport.send(
        .output(binding, sequence: 1, stream: "stdout", text: "fixture"),
        correlationId: execute.messageId, session: session)
      try await transport.send(
        .status(binding, sequence: 2, state: "succeeded", exitCode: 0),
        correlationId: execute.messageId, session: session)
      // The peer closes after validating both results.
      try await transport.waitForDisconnect(session: session)
    case "disconnect", "cancel-heartbeat", "replace", "heartbeat-timeout":
      let receive = Task { try await transport.receiveOperation(session: session) }
      let heartbeat = Task { try await transport.heartbeat(status: "ready") }
      try await Task.sleep(for: .milliseconds(100))
      if mode == "cancel-heartbeat" {
        heartbeat.cancel()
      } else if mode != "heartbeat-timeout" {
        await transport.disconnect()
      }
      try await rejected { _ = try await receive.value }
      try await rejected { try await heartbeat.value }
      if mode == "replace" {
        let replacement = try await transport.connect()
        receive.cancel()
        try await rejected { _ = try await transport.receiveOperation(session: session) }
        try await rejected {
          try await transport.send(
            .capabilities([]), correlationId: UUID().uuidString.lowercased(), session: session)
        }
        try await transport.heartbeat(status: "ready")
        guard replacement.generation > session.generation else {
          fatalError("Session was not replaced")
        }
      }
    case "cancel-observer":
      let observer = Task { try await transport.waitForDisconnect(session: session) }
      try await Task.sleep(for: .milliseconds(100))
      observer.cancel()
      try await rejected { try await observer.value }
      try await transport.heartbeat(status: "ready")
      try await rejected {
        try await transport.send(
          .heartbeat(status: "ready"), correlationId: UUID().uuidString.lowercased(),
          session: session)
      }
      try await transport.heartbeat(status: "ready")
    default:
      try await transport.waitForDisconnect(session: session)
      try await rejected { _ = try await transport.receiveOperation(session: session) }
      try await rejected { try await transport.heartbeat(status: "ready") }
    }
    await transport.disconnect()
    print("Native duplex transport passed")
  }
}
