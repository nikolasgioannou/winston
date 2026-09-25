import Foundation
import ProxyExecution
import ProxyJournal
import WinstonDeviceProtocol

private actor Latch {
  private var opened = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if opened { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func open() {
    opened = true
    for continuation in waiting { continuation.resume() }
    waiting.removeAll()
  }
}

private actor SuspendedJournal: JournalStore {
  let journal: ExecutionJournal
  let entered = Latch()
  let release = Latch()

  init(_ journal: ExecutionJournal) { self.journal = journal }

  func hasUncertainExecution() async throws -> Bool {
    try await journal.hasUncertainExecution()
  }

  func admit(_ message: DeviceMessage) async throws -> JournalAdmission {
    await entered.open()
    await release.wait()
    return try await journal.admit(message)
  }

  func requestCancellation(_ key: JournalKey) async throws -> JournalRecord {
    try await journal.requestCancellation(key)
  }

  func finish(_ key: JournalKey, state: JournalState, exitCode: Int64?) async throws
    -> JournalRecord
  {
    try await journal.finish(key, state: state, exitCode: exitCode)
  }

  func markUncertain(_ key: JournalKey) async throws -> JournalRecord {
    try await journal.markUncertain(key)
  }
}

@main
struct ExecutionTests {
  static let device = "10000000-0000-4000-8000-000000000001"
  static let sessionId = "10000000-0000-4000-8000-000000000002"
  static let taskId = "10000000-0000-4000-8000-000000000003"

  static func message(
    _ index: Int, desktop: Bool = false, file: Bool = false,
    generation: Int64 = 1, deadline: Int64 = 10_000, deviceId: String = device
  ) throws -> DeviceMessage {
    let operation: DeviceOperation
    if desktop {
      operation = .observe(application: "sample", format: "accessibility")
    } else if file {
      operation = .fileRead(path: "/tmp/sample", transferId: taskId)
    } else {
      operation = .command(executable: "/usr/bin/true", arguments: [], directory: "/tmp")
    }
    return try DeviceMessage(
      messageId: UUID().uuidString.lowercased(), correlationId: UUID().uuidString.lowercased(),
      deviceId: deviceId, sessionId: sessionId, generation: generation,
      payload: .execute(
        ExecutionBinding(
          executionId: String(format: "20000000-0000-4000-8000-%012d", index),
          taskId: taskId, taskRevision: 1), deadline: deadline,
        operation: operation))
  }

  static func session(deviceId: String = device) throws -> DeviceSession {
    try DeviceSession(
      data: JSONSerialization.data(withJSONObject: [
        "kind": "session", "version": 1, "deviceId": deviceId, "sessionId": sessionId,
        "generation": 1, "expiresAt": "2099-01-01T00:00:00Z",
      ]))
  }

  static func rejected(
    _ expected: ExecutionRejection, _ coordinator: ExecutionCoordinator, _ message: DeviceMessage
  ) async throws {
    do {
      _ = try await coordinator.execute(message) { _ in fatalError("Rejected handler ran") }
      fatalError("Expected rejection")
    } catch let error as ExecutionRejection {
      precondition(error == expected)
    }
  }

  static func main() async throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try await checkStopAndResources(root.appendingPathComponent("stop"))
    try await checkAdmissionRace(root.appendingPathComponent("race"))
    try await checkUncertainAndDeadline(root.appendingPathComponent("uncertain"))
    try await checkRepairedUncertainty(root.appendingPathComponent("repaired"))
    print("Native execution admission and stop checks passed")
  }

  static func journal(_ directory: URL) throws -> ExecutionJournal {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return try ExecutionJournal(directory: directory)
  }

  static func checkStopAndResources(_ directory: URL) async throws {
    let journal = try journal(directory)
    let coordinator = ExecutionCoordinator(journal: journal, now: { 1000 })
    try await rejected(.stopped, coordinator, message(1))
    await coordinator.resume()
    try await rejected(.staleSession, coordinator, message(1))
    await coordinator.setSession(try session(), capabilities: [.observe])
    try await rejected(.unsupported, coordinator, message(1))
    await coordinator.setSession(try session(), capabilities: [.observe, .command, .fileRead])
    try await rejected(.staleSession, coordinator, message(1, generation: 2))
    try await rejected(.expired, coordinator, message(1, deadline: 1000))

    let entered = Latch()
    let release = Latch()
    let cancellationEntered = Latch()
    let releaseCancellation = DispatchSemaphore(value: 0)
    let first = Task {
      try await coordinator.execute(message(1, desktop: true)) { _ in
        await withTaskCancellationHandler {
          await entered.open()
          // Deliberately ignores cancellation until the test releases it.
          await release.wait()
          return .succeeded(exitCode: 0)
        } onCancel: {
          Task { await cancellationEntered.open() }
          // A poorly behaved handler must not block the coordinator's stop action.
          releaseCancellation.wait()
        }
      }
    }
    await entered.wait()
    try await rejected(.busy, coordinator, message(1, desktop: true))
    try await rejected(.busy, coordinator, message(2, desktop: true))
    try await rejected(.busy, coordinator, message(2))
    let parallelFile = try await coordinator.execute(message(9, file: true)) { _ in .succeeded() }
    precondition(parallelFile.state == .succeeded)
    await coordinator.pause()
    await cancellationEntered.wait()
    try await rejected(.stopped, coordinator, message(3))
    let countWhileStopped = await coordinator.activeCount
    precondition(countWhileStopped == 1)
    await coordinator.resume()
    try await rejected(.busy, coordinator, message(2, desktop: true))
    releaseCancellation.signal()
    await release.open()
    let completed = try await first.value
    precondition(completed.state == .succeeded)
    let duplicate = try await coordinator.execute(message(1, desktop: true)) { _ in
      fatalError("Completed effect replayed")
    }
    precondition(duplicate == completed)

    let enteredSecond = Latch()
    let enteredThird = Latch()
    let releaseCommands = Latch()
    let second = Task {
      try await coordinator.execute(message(2, file: true)) { _ in
        await enteredSecond.open()
        await releaseCommands.wait()
        return .succeeded()
      }
    }
    let third = Task {
      try await coordinator.execute(message(3, file: true)) { _ in
        await enteredThird.open()
        await releaseCommands.wait()
        return .succeeded()
      }
    }
    await enteredSecond.wait()
    await enteredThird.wait()
    try await rejected(.busy, coordinator, message(4, file: true))
    await coordinator.setSession(nil, capabilities: [])
    try await rejected(.staleSession, coordinator, message(4))
    await releaseCommands.open()
    _ = try await second.value
    _ = try await third.value
    await journal.close()
  }

  static func checkAdmissionRace(_ directory: URL) async throws {
    let journal = try journal(directory)
    let store = SuspendedJournal(journal)
    let coordinator = ExecutionCoordinator(store: store, now: { 1000 })
    await coordinator.setSession(try session(), capabilities: [.command])
    await coordinator.resume()
    let pending = Task {
      try await coordinator.execute(message(1)) { _ in fatalError("Paused admission launched") }
    }
    await store.entered.wait()
    await coordinator.pause()
    await store.release.open()
    let canceled = try await pending.value
    precondition(canceled.state == .canceled && canceled.cancellationRequested)
    await journal.close()
  }

  static func checkUncertainAndDeadline(_ directory: URL) async throws {
    let journal = try journal(directory)
    let coordinator = ExecutionCoordinator(journal: journal)
    await coordinator.setSession(try session(), capabilities: [.command])
    await coordinator.resume()
    let deadline = Int64(Date().timeIntervalSince1970 * 1000) + 200
    let expired = try await coordinator.execute(message(1, deadline: deadline)) { _ in
      do { try await Task.sleep(for: .seconds(60)) } catch {}
      return .canceled
    }
    precondition(expired.state == .canceled)

    let failing = try message(2, deadline: deadline + 10_000)
    do {
      _ = try await coordinator.execute(failing) { _ in throw CancellationError() }
      fatalError("Expected uncertain handler error")
    } catch is CancellationError {}
    let uncertain = try await journal.record(
      JournalKey(deviceId: device, executionId: "20000000-0000-4000-8000-000000000002"))
    precondition(uncertain?.state == .uncertain)
    await coordinator.resume()
    try await rejected(
      .reconciliationRequired, coordinator, message(3, deadline: deadline + 10_000))
    let replacement = ExecutionCoordinator(journal: journal, now: { 1000 })
    await replacement.setSession(try session(), capabilities: [.command])
    await replacement.resume()
    try await rejected(.reconciliationRequired, replacement, message(3))
    await journal.close()
  }

  static func checkRepairedUncertainty(_ directory: URL) async throws {
    let original = try journal(directory)
    _ = try await original.admit(message(1))
    await original.close()

    // Reopening recovers unfinished work from the old pairing as uncertain.
    let recovered = try ExecutionJournal(directory: directory)
    let newDevice = "30000000-0000-4000-8000-000000000001"
    let coordinator = ExecutionCoordinator(journal: recovered, now: { 1000 })
    await coordinator.setSession(try session(deviceId: newDevice), capabilities: [.command])
    await coordinator.resume()
    try await rejected(
      .reconciliationRequired, coordinator, message(2, deviceId: newDevice))
    let oldRecord = try await recovered.record(
      JournalKey(deviceId: device, executionId: "20000000-0000-4000-8000-000000000001"))
    let newRecord = try await recovered.record(
      JournalKey(deviceId: newDevice, executionId: "20000000-0000-4000-8000-000000000002"))
    precondition(oldRecord?.state == .uncertain && newRecord == nil)
    await recovered.close()
  }
}
