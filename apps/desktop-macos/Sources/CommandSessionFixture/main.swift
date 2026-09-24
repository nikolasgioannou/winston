import Foundation
import ProxyJournal
import ProxyRuntime
import WinstonDeviceProtocol
import WinstonDeviceTransport

@main
struct CommandSessionFixture {
  static let id = "11111111-1111-4111-8111-111111111111"

  static func main() async throws {
    let endpoint = URL(string: CommandLine.arguments[1])!
    let directory = URL(fileURLWithPath: CommandLine.arguments[2])
    let mode = CommandLine.arguments[3]
    let journalDirectory = directory.appendingPathComponent("journal")
    try FileManager.default.createDirectory(
      at: journalDirectory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    let journal = try ExecutionJournal(directory: journalDirectory)
    if mode == "uncertain" {
      let request = try DeviceMessage(
        data: Data(contentsOf: directory.appendingPathComponent("request.json")))
      _ = try await journal.admit(request)
      _ = try await journal.markUncertain(JournalKey(deviceId: id, executionId: id))
    }
    let runtime = CommandSession(journal: journal, environment: ["PATH": "/usr/bin:/bin"])
    let transport = try DeviceTransport(
      endpoint: endpoint, deviceId: id,
      credential: "wdi_" + String(repeating: "a", count: 43),
      allowInsecureLoopback: true)
    let session = try await transport.connect()
    let heartbeat = Task {
      while !Task.isCancelled {
        try await transport.heartbeat(status: mode == "paused" ? "paused" : "ready")
        try await Task.sleep(for: .milliseconds(50))
      }
    }
    do {
      try await runtime.run(transport: transport, session: session, ready: { mode != "paused" })
    } catch {}
    heartbeat.cancel()
    _ = try? await heartbeat.value
    let key = try JournalKey(deviceId: id, executionId: id)
    let record = try await journal.record(key)
    switch mode {
    case "complete", "duplicate": precondition(record?.state == .succeeded)
    case "cancel", "disconnect": precondition(record?.state == .canceled)
    case "paused": precondition(record == nil)
    case "uncertain": precondition(record?.state == .uncertain)
    default: fatalError("Unknown fixture mode")
    }
    await journal.close()
    print("Native command session checks passed")
  }
}
