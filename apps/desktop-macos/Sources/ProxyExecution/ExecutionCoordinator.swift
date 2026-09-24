import Foundation
import ProxyJournal
import WinstonDeviceProtocol

/// Owns admitted work independently from a socket receive loop or the main actor.
/// The authenticated dispatcher remains responsible for current task/approval policy.
public actor ExecutionCoordinator {
  private struct Entry: Sendable {
    let binding: ExecutionBinding
    let desktop: Bool
    var worker: Task<ExecutionOutcome, Error>?
    var timer: Task<Void, Never>?
    var cancellationRequested = false
  }

  private let journal: any JournalStore
  private let now: @Sendable () -> Int64
  private var session: DeviceSession?
  private var capabilities: Set<DeviceCapability> = []
  private var entries: [JournalKey: Entry] = [:]
  private var epoch: UInt64 = 0
  public private(set) var isPaused = true
  public private(set) var requiresReconciliation = false

  public init(
    journal: ExecutionJournal,
    now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
  ) {
    self.journal = journal
    self.now = now
  }

  package init(store: any JournalStore, now: @escaping @Sendable () -> Int64) {
    journal = store
    self.now = now
  }

  public var activeCount: Int { entries.count }

  /// Session changes stop existing work. They never undo an explicit local pause.
  public func setSession(_ session: DeviceSession?, capabilities: Set<DeviceCapability>) {
    epoch &+= 1
    self.session = session
    self.capabilities = capabilities
    cancelAll()
  }

  public func pause() {
    isPaused = true
    epoch &+= 1
    cancelAll()
  }

  public func resume() {
    if !requiresReconciliation { isPaused = false }
  }

  public func cancel(_ key: JournalKey, binding: ExecutionBinding) {
    guard let entry = entries[key], entry.binding.taskId == binding.taskId,
      entry.binding.taskRevision == binding.taskRevision,
      entry.binding.executionId == binding.executionId
    else { return }
    requestCancellation(key, entry: entry)
  }

  public func execute(
    _ message: DeviceMessage,
    operation: @escaping @Sendable (DeviceOperation) async throws -> ExecutionOutcome
  ) async throws -> JournalRecord {
    try validate(message)
    guard case .execute(let binding, let deadline, let command) = message.payload else {
      throw ExecutionRejection.invalidMessage
    }
    let key = try JournalKey(deviceId: message.deviceId, executionId: binding.executionId)
    guard entries[key] == nil else { throw ExecutionRejection.busy }
    // Broad commands can invoke UI automation too; they share the desktop lease.
    let desktop = [.command, .observe, .input, .application].contains(command.capability)
    let occupied = entries.values.filter { $0.desktop == desktop }.count
    guard occupied < (desktop ? 1 : 2) else { throw ExecutionRejection.busy }

    // Reserve before suspension: another admission cannot take the same resource.
    let admissionEpoch = epoch
    entries[key] = Entry(binding: binding, desktop: desktop)
    defer {
      entries[key]?.timer?.cancel()
      entries.removeValue(forKey: key)
    }

    do {
      let uncertain = try await journal.hasUncertainExecution(deviceId: message.deviceId)
      guard !uncertain else {
        failClosed()
        throw ExecutionRejection.reconciliationRequired
      }
      let admission = try await journal.admit(message)
      if case .existing(let record) = admission { return record }

      // Pause/disconnect/cancel can arrive while persistence is suspended.
      do {
        guard epoch == admissionEpoch, !Task.isCancelled,
          entries[key]?.cancellationRequested != true
        else { throw ExecutionRejection.stopped }
        try validate(message)
      } catch {
        _ = try await journal.requestCancellation(key)
        return try await journal.finish(key, state: .canceled, exitCode: nil)
      }

      let worker = Task.detached {
        if Task.isCancelled { return ExecutionOutcome.canceled }
        return try await operation(command)
      }
      entries[key]?.worker = worker
      entries[key]?.timer = deadlineTask(key: key, binding: binding, deadline: deadline)

      let outcome = try await withTaskCancellationHandler {
        try await worker.value
      } onCancel: {
        Task { await self.cancel(key, binding: binding) }
      }
      return try await journal.finish(key, state: outcome.state, exitCode: outcome.exitCode)
    } catch {
      failClosed()
      _ = try? await journal.markUncertain(key)
      throw error
    }
  }

  private func validate(_ message: DeviceMessage) throws {
    guard !requiresReconciliation else { throw ExecutionRejection.reconciliationRequired }
    guard !isPaused else { throw ExecutionRejection.stopped }
    guard let session, session.deviceId == message.deviceId,
      session.sessionId == message.sessionId, session.generation == message.generation
    else { throw ExecutionRejection.staleSession }
    guard case .execute(_, let deadline, let operation) = message.payload else {
      throw ExecutionRejection.invalidMessage
    }
    guard capabilities.contains(operation.capability) else { throw ExecutionRejection.unsupported }
    guard deadline > now() else { throw ExecutionRejection.expired }
  }

  private func failClosed() {
    guard !requiresReconciliation else { return }
    requiresReconciliation = true
    pause()
  }

  private func cancelAll() {
    for (key, entry) in entries { requestCancellation(key, entry: entry) }
  }

  private func requestCancellation(_ key: JournalKey, entry: Entry) {
    guard !entry.cancellationRequested else { return }
    entries[key]?.cancellationRequested = true
    // Task.cancel can run arbitrary handler code synchronously. Keep it off this actor.
    Task.detached { entry.worker?.cancel() }
    Task {
      do { _ = try await journal.requestCancellation(key) } catch {
        // A reserved entry can still be waiting for its first durable admission.
        if error as? JournalError != .invalidTransition { failClosed() }
      }
    }
  }

  private func deadlineTask(key: JournalKey, binding: ExecutionBinding, deadline: Int64)
    -> Task<Void, Never>
  {
    let now = self.now
    return Task.detached {
      do {
        while !Task.isCancelled {
          let remaining = deadline - now()
          if remaining <= 0 {
            await self.cancel(key, binding: binding)
            return
          }
          try await Task.sleep(for: .milliseconds(min(remaining, 60_000)))
        }
      } catch {}
    }
  }
}
