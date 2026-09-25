import Foundation
import ProxyJournal
import WinstonDeviceProtocol

func checkWriteSources(_ journal: ExecutionJournal) async throws {
  let artifactId = "40000000-0000-4000-8000-000000000001"
  let digest = String(repeating: "a", count: 64)
  let source = try DeviceFileSource(artifactId: artifactId, revision: 2, size: 1024, sha256: digest)
  let executionId = "40000000-0000-4000-8000-000000000002"
  let transferId = "40000000-0000-4000-8000-000000000003"
  let binding = ExecutionBinding(executionId: executionId, taskId: taskId, taskRevision: 1)
  func message(_ descriptor: DeviceFileSource, query: Bool = false) throws -> DeviceMessage {
    let operation = DeviceOperation.fileWrite(
      path: "/fixtures/report.txt", transferId: transferId, overwrite: false, source: descriptor)
    return try DeviceMessage(
      messageId: UUID().uuidString.lowercased(), correlationId: UUID().uuidString.lowercased(),
      deviceId: deviceId, sessionId: UUID().uuidString.lowercased(), generation: 2,
      payload: query
        ? .reconcile(binding, operation: operation)
        : .execute(binding, deadline: 2_000_000_000_000, operation: operation))
  }
  guard case .admitted = try await journal.admit(message(source)) else {
    fatalError("Expected new file operation")
  }
  let key = try JournalKey(deviceId: deviceId, executionId: executionId)
  _ = try await journal.finish(key, state: .succeeded, exitCode: 0)
  guard case .existing(let record) = try await journal.admit(message(source)),
    record.state == .succeeded
  else {
    fatalError("Completed file operation was not retained")
  }
  for changed in [
    try DeviceFileSource(
      artifactId: UUID().uuidString.lowercased(), revision: 2, size: 1024, sha256: digest),
    try DeviceFileSource(artifactId: artifactId, revision: 3, size: 1024, sha256: digest),
    try DeviceFileSource(artifactId: artifactId, revision: 2, size: 1025, sha256: digest),
    try DeviceFileSource(
      artifactId: artifactId, revision: 2, size: 1024, sha256: String(repeating: "b", count: 64)),
  ] {
    try await expectError(.conflictingExecution) {
      _ = try await journal.admit(message(changed))
    }
    guard
      case .reconciled(_, "conflict", nil) = try await journal.reconcile(
        message(changed, query: true))
    else {
      fatalError("Different file source matched the completed operation")
    }
  }
  guard
    case .reconciled(_, "succeeded", 0) = try await journal.reconcile(message(source, query: true))
  else {
    fatalError("Original file source lost its completion receipt")
  }
}
