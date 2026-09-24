import Darwin
import Foundation
import ProxyCommands
import ProxyExecution
import ProxyJournal
import WinstonDeviceProtocol

private actor TextCapture {
  var stdout = ""
  var stderr = ""

  func append(_ stream: CommandOutput.Stream, _ text: String) {
    switch stream {
    case .stdout: stdout += text
    case .stderr: stderr += text
    }
  }
}

private enum FixtureError: Error { case delivery }

@main
struct CommandHandlerFixture {
  static let device = "10000000-0000-4000-8000-000000000001"
  static let sessionId = "10000000-0000-4000-8000-000000000002"
  static let taskId = "10000000-0000-4000-8000-000000000003"

  static func message(_ index: Int, operation: DeviceOperation) throws -> DeviceMessage {
    try DeviceMessage(
      messageId: UUID().uuidString.lowercased(), correlationId: UUID().uuidString.lowercased(),
      deviceId: device, sessionId: sessionId, generation: 1,
      payload: .execute(
        ExecutionBinding(
          executionId: String(format: "20000000-0000-4000-8000-%012d", index),
          taskId: taskId, taskRevision: 1),
        deadline: Int64(Date().addingTimeInterval(15).timeIntervalSince1970 * 1000),
        operation: operation))
  }

  static func run(
    _ coordinator: ExecutionCoordinator, _ request: DeviceMessage,
    outputLimit: Int = 1_048_576,
    output: @escaping @Sendable (CommandOutput.Stream, String) async throws -> Void
  ) async throws -> JournalRecord {
    guard case .execute(_, let deadline, _) = request.payload else { fatalError("Invalid fixture") }
    let executor = CommandExecutor(environment: [
      "PATH": "/usr/bin:/bin", "WINSTON_FIXTURE": "explicit",
    ])
    return try await coordinator.execute(request) { operation in
      try await executor.execute(
        operation, deadline: deadline, outputLimit: outputLimit, output: output)
    }
  }

  static func decoding() {
    let samples: [[UInt8]] = [
      Array("plain 😀 é 終".utf8), [0, 0xff, 0xc2, 0xa9],
      [0xf0, 0x9f], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80], [0xc2, 0xc2, 0xa9], [],
    ]
    for bytes in samples {
      let expected = String(decoding: bytes, as: UTF8.self).replacingOccurrences(
        of: "\0", with: "\u{fffd}")
      for split in 0...bytes.count {
        var decoder = CommandTextDecoder()
        let result =
          decoder.append(Data(bytes.prefix(split)))
          + decoder.append(Data(bytes.dropFirst(split))) + decoder.append(Data(), final: true)
        precondition(result == expected)
      }
      var decoder = CommandTextDecoder()
      var result = ""
      for byte in bytes { result += decoder.append(Data([byte])) }
      result += decoder.append(Data(), final: true)
      precondition(result == expected)
    }
  }

  static func main() async throws {
    if CommandLine.arguments[1] == "--hold-pipe" {
      precondition(setsid() >= 0)
      try Data("ready".utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
      try await Task.sleep(for: .seconds(5))
      return
    }
    decoding()
    let directory = CommandLine.arguments[1]
    let journalDirectory = URL(fileURLWithPath: directory).appendingPathComponent("journal")
    try FileManager.default.createDirectory(
      at: journalDirectory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    let journal = try ExecutionJournal(directory: journalDirectory)
    let coordinator = ExecutionCoordinator(journal: journal)
    let session = try DeviceSession(
      data: JSONSerialization.data(withJSONObject: [
        "kind": "session", "version": 1, "deviceId": device, "sessionId": sessionId,
        "generation": 1, "expiresAt": "2099-01-01T00:00:00Z",
      ]))
    await coordinator.setSession(session, capabilities: [.command])
    await coordinator.resume()
    func shell(_ script: String, arguments: [String] = []) -> DeviceOperation {
      .command(
        executable: "/bin/sh", arguments: ["-c", script, "fixture"] + arguments,
        directory: directory)
    }
    let capture = TextCapture()
    let basic = try message(
      1,
      operation: shell(
        "printf '%s\\n' \"$WINSTON_FIXTURE\" \"${WINSTON_PARENT_ONLY-unset}\"; printf '\\360\\237'; sleep 0.05; printf '\\230\\200\\000\\377'; printf error >&2; exit 7"
      ))
    let basicResult = try await run(coordinator, basic) { await capture.append($0, $1) }
    precondition(basicResult.state == .failed && basicResult.exitCode == 7)
    let stdout = await capture.stdout
    let stderr = await capture.stderr
    precondition(stdout == "explicit\nunset\n😀\u{fffd}\u{fffd}" && stderr == "error")
    let duplicate = try await run(coordinator, basic) { _, _ in
      fatalError("Duplicate execution ran")
    }
    precondition(duplicate == basicResult)

    let missingCapture = TextCapture()
    let missing = try message(
      2,
      operation: .command(executable: directory + "/missing", arguments: [], directory: directory))
    let missingResult = try await run(coordinator, missing) { await missingCapture.append($0, $1) }
    precondition(missingResult.state == .failed)
    let missingError = await missingCapture.stderr
    precondition(missingError.contains("Could not start command"))
    let stoppedAfterMissing = await coordinator.requiresReconciliation
    precondition(!stoppedAfterMissing)

    let ready = directory + "/cancel-ready"
    let long = try message(
      3, operation: shell("printf ready > \"$1\"; sleep 10", arguments: [ready]))
    let working = Task { try await run(coordinator, long) { _, _ in } }
    for _ in 0..<100 {
      if FileManager.default.fileExists(atPath: ready) { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    precondition(FileManager.default.fileExists(atPath: ready))
    await coordinator.pause()
    let paused = await coordinator.isPaused
    precondition(paused)
    let canceled = try await working.value
    precondition(canceled.state == .canceled && canceled.cancellationRequested)
    await coordinator.resume()

    let brokenOutput = try message(4, operation: shell("printf start; sleep 10"))
    let deliveryResult = try await run(coordinator, brokenOutput) { _, _ in
      throw FixtureError.delivery
    }
    precondition(deliveryResult.state == .canceled)
    let active = await coordinator.activeCount
    precondition(active == 0)

    let noisy = try message(6, operation: shell("/usr/bin/yes fixture"))
    let limited = try await run(coordinator, noisy, outputLimit: 512) { _, _ in }
    precondition(limited.state == .failed)

    let escapedReady = directory + "/escaped-ready"
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
    let escapedOutput = TextCapture()
    let escaped = try message(
      5,
      operation: shell(
        "\"$1\" --hold-pipe \"$2\" & while [ ! -e \"$2\" ]; do sleep 0.02; done; exit 0",
        arguments: [executable, escapedReady]))
    do {
      let result = try await run(coordinator, escaped) { await escapedOutput.append($0, $1) }
      let detail = await escapedOutput.stderr
      fatalError("Escaped pipe owner returned \(result.state): \(detail)")
    } catch CommandExecutionError.uncertain {}
    let uncertain = try await journal.hasUncertainExecution(deviceId: device)
    let requiresReconciliation = await coordinator.requiresReconciliation
    precondition(uncertain && requiresReconciliation)
    // The disposable detached fixture exits by itself; allow it to finish before teardown.
    try await Task.sleep(for: .seconds(2.2))
    await journal.close()
    print("Native command handler and journal checks passed")
  }
}
