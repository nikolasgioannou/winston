import Foundation
import ProxyJournal
import ProxyRuntime
import WinstonDeviceProtocol
import WinstonDeviceTransport

private actor ConnectionState {
  private(set) var value: DeviceConnectionState = .stopped

  func set(_ value: DeviceConnectionState) { self.value = value }
}

private struct FixtureIdentity: Decodable {
  let deviceId: String
  let credential: String
}

@main
struct CommandSessionFixture {
  static let id = "11111111-1111-4111-8111-111111111111"

  static func main() async throws {
    let endpoint = URL(string: CommandLine.arguments[1])!
    let directory = URL(fileURLWithPath: CommandLine.arguments[2])
    let mode = CommandLine.arguments[3]
    let identity: FixtureIdentity
    if mode == "integrated" {
      identity = try JSONDecoder().decode(
        FixtureIdentity.self,
        from: Data(contentsOf: directory.appendingPathComponent("identity.json")))
    } else {
      identity = FixtureIdentity(
        deviceId: id, credential: "wdi_" + String(repeating: "a", count: 43))
    }
    let id = identity.deviceId
    let journalDirectory = directory.appendingPathComponent("journal")
    if mode == "uncertain" || mode == "repaired" {
      try FileManager.default.createDirectory(
        at: journalDirectory, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
      let journal = try ExecutionJournal(directory: journalDirectory)
      let request = try DeviceMessage(
        data: Data(contentsOf: directory.appendingPathComponent("request.json")))
      _ = try await journal.admit(request)
      _ = try await journal.markUncertain(JournalKey(deviceId: request.deviceId, executionId: id))
      await journal.close()
    }
    let runtime = ExecutionConnection(
      directory: journalDirectory, environment: ["PATH": "/usr/bin:/bin"])
    let transport = try DeviceTransport(
      endpoint: endpoint, deviceId: id,
      credential: identity.credential,
      allowInsecureLoopback: true)
    let state = ConnectionState()
    let connection = Task {
      try await runtime.run(
        transport: transport, onState: { await state.set($0) },
        status: { mode == "paused" ? .paused : .ready })
    }
    // Each scenario closes its server session. Stop during reconnect backoff,
    // after the loop has joined the command handler and its owned workers.
    while await state.value != .disconnected {
      try await Task.sleep(for: .milliseconds(5))
    }
    connection.cancel()
    try await connection.value
    let stopped = await state.value
    precondition(stopped == .stopped)
    // Reopen only after the wrapper returns: its lock must be released and its
    // worker's terminal outcome must already be durable.
    let journal = try ExecutionJournal(directory: journalDirectory)
    let key = try JournalKey(deviceId: id, executionId: id)
    let record = try await journal.record(key)
    switch mode {
    case "complete", "duplicate": precondition(record?.state == .succeeded)
    case "cancel", "disconnect": precondition(record?.state == .canceled)
    case "paused", "repaired": precondition(record == nil)
    case "uncertain": precondition(record?.state == .uncertain)
    case "integrated": break
    default: fatalError("Unknown fixture mode")
    }
    await journal.close()
    print("Native command session checks passed")
  }
}
