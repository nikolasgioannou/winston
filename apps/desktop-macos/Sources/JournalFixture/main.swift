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
  try await expectError(.conflictingExecution) {
    _ = try await journal.admit(request(1, text: "different"))
  }
  if case .existing = try await journal.admit(request(1, generation: 2)) {
  } else {
    fatalError("Reconnection must retain the execution identity")
  }
  let canceled = try await journal.requestCancellation(key(1))
  precondition(canceled.state == .cancelRequested)
  let completed = try await journal.finish(key(1), state: .succeeded, exitCode: 0)
  precondition(completed.state == .succeeded && completed.cancellationRequested)
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
  try await expectError(.unavailable) { _ = try await journal.admit(request(2)) }
  let reopened = try ExecutionJournal(directory: directory)
  let persisted = try await reopened.record(key(1))
  precondition(persisted == completed)
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
