import Foundation
import WinstonDeviceProtocol

/// One channel owns one socket for its entire lifetime. Closing discards queued input;
/// no work buffered on an obsolete connection can leak into its replacement.
actor DeviceChannel {
  private struct Pending<Value: Sendable> {
    let id: UUID
    let continuation: CheckedContinuation<Value, Error>
  }

  private struct Heartbeat {
    let message: DeviceMessage
    let status: String
    let continuation: CheckedContinuation<Void, Error>
    let timeout: Task<Void, Never>
  }

  private struct Send {
    let message: DeviceMessage
    let continuation: CheckedContinuation<Void, Error>
  }

  let session: DeviceSession
  private let socket: URLSessionWebSocketTask
  private var closed = false
  private var reader: Task<Void, Never>?
  private var writer: Task<Void, Never>?
  private var inbox: [DeviceMessage] = []
  private var sends: [Send] = []
  private var operation: Pending<DeviceMessage>?
  private var disconnected: Pending<Void>?
  private var heartbeat: Heartbeat?

  init(socket: URLSessionWebSocketTask, session: DeviceSession) {
    self.socket = socket
    self.session = session
  }

  func start() {
    guard reader == nil, !closed else { return }
    reader = Task {
      do {
        while !Task.isCancelled {
          guard case .string(let text) = try await socket.receive() else {
            throw DeviceTransportError.invalidSession
          }
          let message = try DeviceMessage(data: Data(text.utf8))
          try accept(message)
        }
      } catch { close() }
    }
  }

  func receiveOperation() async throws -> DeviceMessage {
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      guard !closed else { throw DeviceTransportError.unavailable }
      guard operation == nil else { throw DeviceTransportError.busy }
      if !inbox.isEmpty { return inbox.removeFirst() }
      return try await withCheckedThrowingContinuation { continuation in
        operation = Pending(id: UUID(), continuation: continuation)
      }
    } onCancel: {
      Task { await self.close() }
    }
  }

  func waitForDisconnect() async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      if closed { return }
      guard disconnected == nil else { throw DeviceTransportError.busy }
      try await withCheckedThrowingContinuation { continuation in
        disconnected = Pending(id: id, continuation: continuation)
      }
    } onCancel: {
      Task { await self.cancelDisconnectWaiter(id) }
    }
  }

  func sendHeartbeat(status: String) async throws {
    guard heartbeat == nil else { throw DeviceTransportError.busy }
    let message = try envelope(
      .heartbeat(status: status), correlationId: UUID().uuidString.lowercased())
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      guard !closed else { throw DeviceTransportError.unavailable }
      try await withCheckedThrowingContinuation { continuation in
        let timeout = Task {
          do {
            try await Task.sleep(for: .seconds(10))
            close()
          } catch {}
        }
        heartbeat = Heartbeat(
          message: message, status: status, continuation: continuation, timeout: timeout)
        Task {
          do { try await write(message) } catch { close() }
        }
      }
    } onCancel: {
      Task { await self.close() }
    }
  }

  func send(_ payload: DevicePayload, correlationId: String) async throws {
    switch payload {
    case .capabilities, .status, .output, .file, .observation, .error, .reconciled:
      try await write(envelope(payload, correlationId: correlationId))
    default:
      throw DeviceTransportError.invalidConfiguration
    }
  }

  func close() {
    guard !closed else { return }
    closed = true
    socket.cancel(with: .goingAway, reason: nil)
    reader?.cancel()
    writer?.cancel()
    reader = nil
    writer = nil
    inbox.removeAll()
    heartbeat?.timeout.cancel()
    heartbeat?.continuation.resume(throwing: DeviceTransportError.unavailable)
    heartbeat = nil
    operation?.continuation.resume(throwing: DeviceTransportError.unavailable)
    operation = nil
    disconnected?.continuation.resume()
    disconnected = nil
    for send in sends { send.continuation.resume(throwing: DeviceTransportError.unavailable) }
    sends.removeAll()
  }

  private func envelope(_ payload: DevicePayload, correlationId: String) throws -> DeviceMessage {
    try DeviceMessage(
      messageId: UUID().uuidString.lowercased(), correlationId: correlationId,
      deviceId: session.deviceId, sessionId: session.sessionId, generation: session.generation,
      payload: payload)
  }

  private func accept(_ message: DeviceMessage) throws {
    guard !closed, message.deviceId == session.deviceId,
      message.sessionId == session.sessionId, message.generation == session.generation
    else { throw DeviceTransportError.invalidSession }
    switch message.payload {
    case .heartbeat(let status):
      guard let waiting = heartbeat, message.correlationId == waiting.message.messageId,
        status == waiting.status
      else { throw DeviceTransportError.invalidSession }
      heartbeat = nil
      waiting.timeout.cancel()
      waiting.continuation.resume()
    case .execute, .cancel, .reconcile:
      if let waiting = operation {
        operation = nil
        waiting.continuation.resume(returning: message)
      } else {
        guard inbox.count < 32 else { throw DeviceTransportError.unavailable }
        inbox.append(message)
      }
    default:
      throw DeviceTransportError.invalidSession
    }
  }

  private func write(_ message: DeviceMessage) async throws {
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      guard !closed else { throw DeviceTransportError.unavailable }
      guard sends.count < 8 else {
        close()
        throw DeviceTransportError.unavailable
      }
      try await withCheckedThrowingContinuation { continuation in
        sends.append(Send(message: message, continuation: continuation))
        if writer == nil { writer = Task { await flush() } }
      }
    } onCancel: {
      // A canceled send may already have reached the peer. Never retry it here.
      Task { await self.close() }
    }
  }

  private func flush() async {
    do {
      while let next = sends.first, !closed {
        let text = String(decoding: next.message.encoded(), as: UTF8.self)
        try await socket.send(.string(text))
        guard !closed else { return }
        sends.removeFirst().continuation.resume()
      }
      writer = nil
    } catch { close() }
  }

  private func cancelDisconnectWaiter(_ id: UUID) {
    guard disconnected?.id == id else { return }
    disconnected?.continuation.resume(throwing: CancellationError())
    disconnected = nil
  }
}
