import Darwin
import Foundation
import ProxyFileTransfer
import ProxyFiles
import ProxyJournal
import ProxyRuntime
import WinstonDeviceProtocol
import WinstonDeviceTransport

private actor ConnectionState {
  private(set) var value: DeviceConnectionState = .stopped
  func set(_ value: DeviceConnectionState) { self.value = value }
}

@main
struct FileWriteSessionFixture {
  static let id = "11111111-1111-4111-8111-111111111111"

  static func main() async throws {
    let endpoint = URL(string: CommandLine.arguments[1])!
    guard let canonical = realpath(CommandLine.arguments[2], nil) else {
      fatalError("Fixture root")
    }
    let path = String(cString: canonical)
    free(canonical)
    let directory = URL(fileURLWithPath: path)
    let mode = CommandLine.arguments[3]
    var origin = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
    origin.scheme = "http"
    origin.path = ""
    let credential = "wdi_" + String(repeating: "a", count: 43)
    let downloader = try DeviceFileDownloader(
      origin: origin.url!, deviceId: id, credential: credential, allowInsecureLoopback: true)
    let root = try FileWriteRoot(path: path)
    let journalDirectory = directory.appendingPathComponent("journal")
    if mode == "restart" {
      try FileManager.default.createDirectory(
        at: journalDirectory, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
      let interrupted = try ExecutionJournal(directory: journalDirectory)
      let request = try DeviceMessage(
        data: Data(contentsOf: directory.appendingPathComponent("request.json")))
      _ = try await interrupted.admit(request)
      await interrupted.close()
    }
    let runtime = ExecutionConnection(
      directory: journalDirectory, environment: ["PATH": "/usr/bin:/bin"],
      fileWrites: FileWriteConfiguration(downloader: downloader, root: root))
    let transport = try DeviceTransport(
      endpoint: endpoint, deviceId: id, credential: credential, allowInsecureLoopback: true)
    let state = ConnectionState()
    let connection = Task {
      try await runtime.run(
        transport: transport, onState: { await state.set($0) }, status: { .ready })
    }
    while await state.value != .disconnected { try await Task.sleep(for: .milliseconds(5)) }
    connection.cancel()
    try await connection.value
    let stopped = await state.value
    precondition(stopped == .stopped)
    if mode == "cleanup" { precondition(chmod(path, 0o700) == 0) }
    let journal = try ExecutionJournal(directory: journalDirectory)
    let record = try await journal.record(JournalKey(deviceId: id, executionId: id))
    switch mode {
    case "complete", "duplicate", "parallel": precondition(record?.state == .succeeded)
    case "denied", "corrupt", "collision": precondition(record?.state == .failed)
    case "cancel", "disconnect", "active-duplicate": precondition(record?.state == .canceled)
    case "restart", "cleanup": precondition(record?.state == .uncertain)
    default: fatalError("Unknown fixture mode")
    }
    if mode == "parallel" {
      for execution in [
        "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333",
      ] {
        let other = try await journal.record(JournalKey(deviceId: id, executionId: execution))
        precondition(other?.state == .succeeded)
      }
    }
    await journal.close()
    let files = try FileManager.default.contentsOfDirectory(atPath: path)
    let temporary = files.filter { $0.hasPrefix(".winston-transfer-") }
    precondition(temporary.count == (mode == "cleanup" ? 1 : 0))
    let target = directory.appendingPathComponent("destination")
    if ["complete", "duplicate", "parallel"].contains(mode) {
      let bytes = try Data(contentsOf: target)
      precondition(bytes == Data(repeating: 42, count: 180_000))
    } else if mode == "collision" {
      let bytes = try Data(contentsOf: target)
      precondition(bytes == Data("original".utf8))
    } else {
      precondition(!FileManager.default.fileExists(atPath: target.path))
    }
    print("Native file write session checks passed")
  }
}
