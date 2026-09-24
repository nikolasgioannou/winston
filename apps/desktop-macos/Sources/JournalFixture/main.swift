import Foundation
import ProxyJournal
import WinstonDeviceProtocol

let deviceId = "10000000-0000-4000-8000-000000000001"
let taskId = "10000000-0000-4000-8000-000000000002"

func request(_ index: Int, text: String = "sample", generation: Int64 = 1) throws -> DeviceMessage {
  try DeviceMessage(
    messageId: UUID().uuidString.lowercased(), correlationId: UUID().uuidString.lowercased(),
    deviceId: deviceId, sessionId: UUID().uuidString.lowercased(), generation: generation,
    payload: .execute(
      ExecutionBinding(
        executionId: String(format: "20000000-0000-4000-8000-%012d", index),
        taskId: taskId, taskRevision: 1),
      deadline: 2_000_000_000_000 + generation,
      operation: .command(executable: "/usr/bin/true", arguments: [text], directory: "/tmp")))
}

func key(_ index: Int) throws -> JournalKey {
  try JournalKey(
    deviceId: deviceId, executionId: String(format: "20000000-0000-4000-8000-%012d", index))
}

func query(_ index: Int, text: String = "sample") throws -> DeviceMessage {
  let original = try request(index, text: text, generation: 9)
  guard case .execute(let binding, _, let operation) = original.payload else {
    fatalError("Expected execution fixture")
  }
  return try DeviceMessage(
    messageId: original.messageId, correlationId: original.correlationId,
    deviceId: original.deviceId, sessionId: original.sessionId, generation: original.generation,
    payload: .reconcile(binding, operation: operation))
}

func checkReconciliation(
  _ journal: ExecutionJournal, index: Int, state: String, exitCode: Int64? = nil,
  text: String = "sample"
) async throws {
  let message = try query(index, text: text)
  precondition(
    !message.acceptsExecution(
      deviceId: message.deviceId, sessionId: message.sessionId, generation: message.generation,
      taskId: taskId, taskRevision: 1, now: 0, capabilities: [.command]))
  let result = try await journal.reconcile(message)
  guard case .reconciled(let binding, let actual, let code) = result else {
    fatalError("Expected journal evidence")
  }
  let expectedKey = try key(index)
  precondition(binding.executionId == expectedKey.executionId)
  precondition(actual == state && code == exitCode)
  // Exercise the exact encoder/decoder used by the native socket.
  _ = try DeviceMessage(
    messageId: UUID().uuidString.lowercased(), correlationId: message.messageId,
    deviceId: message.deviceId, sessionId: message.sessionId, generation: message.generation,
    payload: result)
}

func expectError(_ expected: JournalError, _ action: () async throws -> Void) async throws {
  do {
    try await action()
    fatalError("Expected journal rejection")
  } catch let error as JournalError {
    precondition(error == expected)
  }
}

let mode = CommandLine.arguments[1]
let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)

switch mode {
case "exercise":
  let journal = try ExecutionJournal(directory: directory)
  try await checkReconciliation(journal, index: 1, state: "missing")
  let absent = try await journal.record(key(1))
  precondition(absent == nil)
  let message = try request(1)
  let admissions = try await withThrowingTaskGroup(of: JournalAdmission.self) { group in
    for _ in 0..<20 {
      group.addTask { try await journal.admit(message) }
    }
    var results: [JournalAdmission] = []
    for try await result in group { results.append(result) }
    return results
  }
  precondition(admissions.filter { if case .admitted = $0 { true } else { false } }.count == 1)
  try await checkReconciliation(journal, index: 1, state: "running")
  try await checkReconciliation(journal, index: 1, state: "conflict", text: "different")
  guard case .execute(let binding, _, let operation) = message.payload else {
    fatalError("Expected fixture command")
  }
  for changed in [
    ExecutionBinding(
      executionId: binding.executionId, taskId: UUID().uuidString.lowercased(), taskRevision: 1),
    ExecutionBinding(executionId: binding.executionId, taskId: taskId, taskRevision: 2),
  ] {
    let mismatched = try DeviceMessage(
      messageId: message.messageId, correlationId: message.correlationId,
      deviceId: message.deviceId, sessionId: message.sessionId, generation: message.generation,
      payload: .reconcile(changed, operation: operation))
    guard case .reconciled(_, "conflict", nil) = try await journal.reconcile(mismatched) else {
      fatalError("Different task binding matched the journal")
    }
  }
  try await expectError(.invalidRequest) { _ = try await journal.reconcile(message) }
  try await expectError(.conflictingExecution) {
    _ = try await journal.admit(request(1, text: "different"))
  }
  if case .existing = try await journal.admit(request(1, generation: 2)) {
  } else {
    fatalError("Reconnection must retain the execution identity")
  }
  let canceled = try await journal.requestCancellation(key(1))
  precondition(canceled.state == .cancelRequested)
  try await checkReconciliation(journal, index: 1, state: "cancel_requested")
  let completed = try await journal.finish(key(1), state: .succeeded, exitCode: 0)
  precondition(completed.state == .succeeded && completed.cancellationRequested)
  try await checkReconciliation(journal, index: 1, state: "succeeded", exitCode: 0)
  let repeated = try await journal.finish(key(1), state: .succeeded, exitCode: 0)
  precondition(repeated == completed)
  let lateCancellation = try await journal.requestCancellation(key(1))
  precondition(lateCancellation == completed)
  try await expectError(.conflictingExecution) {
    _ = try await journal.finish(key(1), state: .canceled)
  }
  try await expectError(.invalidTransition) {
    _ = try await journal.finish(key(2), state: .succeeded)
  }
  try await expectError(.alreadyOpen) {
    _ = try ExecutionJournal(directory: directory)
  }
  await journal.close()
  try await checkReconciliation(journal, index: 1, state: "unavailable")
  try await expectError(.unavailable) { _ = try await journal.admit(request(2)) }
  let reopened = try ExecutionJournal(directory: directory)
  let persisted = try await reopened.record(key(1))
  precondition(persisted == completed)
  try await checkReconciliation(reopened, index: 1, state: "succeeded", exitCode: 0)
  let otherDevice = try JournalKey(
    deviceId: "30000000-0000-4000-8000-000000000001", executionId: key(1).executionId)
  let isolated = try await reopened.record(otherDevice)
  precondition(isolated == nil)
  await reopened.close()
  print("Journal state checks passed")

case "crash":
  let journal = try ExecutionJournal(directory: directory)
  for index in 1...3 { _ = try await journal.admit(request(index)) }
  _ = try await journal.requestCancellation(key(2))
  _ = try await journal.finish(key(3), state: .failed, exitCode: 7)
  FileHandle.standardOutput.write(Data("committed\n".utf8))
  while true { try await Task.sleep(for: .seconds(60)) }

case "locked":
  try await expectError(.alreadyOpen) { _ = try ExecutionJournal(directory: directory) }
  print("Concurrent owner rejected")

case "recover":
  let journal = try ExecutionJournal(directory: directory)
  for index in 1...2 {
    let record = try await journal.record(key(index))
    precondition(record?.state == .uncertain)
    try await checkReconciliation(journal, index: index, state: "uncertain")
    precondition(record?.cancellationRequested == (index == 2))
    if case .existing = try await journal.admit(request(index)) {
    } else {
      fatalError("Interrupted operations must not be replayed")
    }
    try await expectError(.invalidTransition) {
      _ = try await journal.finish(key(index), state: .succeeded)
    }
  }
  let completed = try await journal.record(key(3))
  precondition(completed?.state == .failed && completed?.exitCode == 7)
  await journal.close()
  print("Crash recovery checks passed")

case "unavailable":
  try await expectError(.unavailable) { _ = try ExecutionJournal(directory: directory) }
  print("Unsafe storage rejected")

default:
  fatalError("Unknown fixture mode")
}
