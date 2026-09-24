import Foundation
import ProxyExecution
import ProxyJournal
import WinstonDeviceProtocol
import WinstonDeviceTransport

/// Handles control traffic independently of owned command execution and heartbeats.
public actor CommandSession {
  private struct Worker {
    let binding: ExecutionBinding
    let execution: Task<JournalRecord, Error>
    let task: Task<Void, Never>
  }

  private let journal: ExecutionJournal
  private let coordinator: ExecutionCoordinator
  private let executor: CommandExecutor
  private var workers: [JournalKey: Worker] = [:]
  private var running = false

  public init(journal: ExecutionJournal, environment: [String: String]) {
    self.journal = journal
    coordinator = ExecutionCoordinator(journal: journal)
    executor = CommandExecutor(environment: environment)
  }

  public func run(
    transport: DeviceTransport, session: DeviceSession,
    ready: @escaping @Sendable () async -> Bool
  ) async throws {
    guard !running else { throw DeviceTransportError.busy }
    running = true
    defer { running = false }
    do {
      let uncertain = try await journal.hasUncertainExecution(deviceId: session.deviceId)
      let blocked = await coordinator.requiresReconciliation
      let capabilities: Set<DeviceCapability> = uncertain || blocked ? [] : [.command]
      await coordinator.setSession(session, capabilities: capabilities)
      if !capabilities.isEmpty, await ready() {
        await coordinator.resume()
      } else {
        await coordinator.pause()
      }
      try await withTaskCancellationHandler {
        try Task.checkCancellation()
        try await transport.send(
          .capabilities(Array(capabilities)),
          correlationId: UUID().uuidString.lowercased(), session: session)
        while !Task.isCancelled {
          let request = try await transport.receiveOperation(session: session)
          switch request.payload {
          case .execute(let binding, let deadline, let operation):
            guard operation.capability == .command, await ready() else {
              throw ExecutionRejection.stopped
            }
            let key = try JournalKey(deviceId: request.deviceId, executionId: binding.executionId)
            guard workers.isEmpty else { throw ExecutionRejection.busy }
            let replies = CommandReplies(
              transport: transport, session: session,
              request: request, binding: binding)
            let execution = Task { [coordinator, executor] in
              try await coordinator.execute(request) { command in
                try await replies.running()
                return try await executor.execute(command, deadline: deadline) { stream, text in
                  try await replies.output(stream, text)
                }
              }
            }
            // Cancel execution independently, so its reporter can still send the
            // journal-confirmed result over a healthy connection.
            let worker = Task {
              do {
                let record = try await execution.value
                try await replies.finish(record)
              } catch {
                // An absent result is uncertain to the server. Do not turn it into
                // a fabricated terminal status or repeat the effect on reconnect.
                await transport.disconnect()
              }
              self.workers.removeValue(forKey: key)
            }
            workers[key] = Worker(binding: binding, execution: execution, task: worker)
          case .cancel(let binding):
            let key = try JournalKey(deviceId: request.deviceId, executionId: binding.executionId)
            if let worker = workers[key], worker.binding.taskId == binding.taskId,
              worker.binding.taskRevision == binding.taskRevision
            {
              worker.execution.cancel()
              await coordinator.cancel(key, binding: binding)
            }
          case .reconcile:
            let response = try await journal.reconcile(request)
            try await transport.send(response, correlationId: request.messageId, session: session)
          default:
            throw DeviceTransportError.invalidSession
          }
        }
      } onCancel: {
        Task {
          await transport.disconnect()
          await self.pause()
        }
      }
    } catch {
      await transport.disconnect()
      await stop()
      throw error
    }
    await stop()
  }

  public func pause() async {
    await coordinator.pause()
    for worker in workers.values { worker.execution.cancel() }
  }

  private func stop() async {
    await pause()
    let stopping = workers.values.map(\.task)
    for task in stopping { await task.value }
    await coordinator.setSession(nil, capabilities: [])
  }
}
