import Foundation
import WinstonDeviceProtocol

public enum DeviceAvailability: String, Sendable {
  case ready, locked, sleeping, paused
}

public enum DeviceConnectionState: Sendable {
  case stopped, connecting, connected, disconnected, pairingRequired
}

public actor DeviceConnectionLoop {
  public private(set) var state: DeviceConnectionState = .stopped
  private let transport: DeviceTransport
  private var running = false
  private var failures = 0

  public init(transport: DeviceTransport) {
    self.transport = transport
  }

  public func run(
    onState: @escaping @Sendable (DeviceConnectionState) async -> Void = { _ in },
    status: @escaping @Sendable () async -> DeviceAvailability,
    handleSession: (@Sendable (DeviceSession) async throws -> Void)? = nil
  ) async throws {
    guard !running else { throw DeviceTransportError.busy }
    running = true
    defer { running = false }
    failures = 0
    while !Task.isCancelled {
      do {
        state = .connecting
        await onState(state)
        try Task.checkCancellation()
        let session = try await transport.connect()
        try await withThrowingTaskGroup(of: Void.self) { group in
          group.addTask { try await self.heartbeats(onState: onState, status: status) }
          group.addTask {
            try await self.transport.waitForDisconnect(session: session)
            throw DeviceTransportError.unavailable
          }
          if let handleSession {
            group.addTask {
              try await handleSession(session)
              // A completed handler cannot leave a connected but unserviced session.
              throw DeviceTransportError.unavailable
            }
          }
          // Structured concurrency joins handler cleanup before reconnecting.
          defer { group.cancelAll() }
          _ = try await group.next()
        }
      } catch DeviceTransportError.pairingRequired {
        await transport.disconnect()
        state = Task.isCancelled ? .stopped : .pairingRequired
        await onState(state)
        return
      } catch {
        await transport.disconnect()
        if Task.isCancelled { break }
        state = .disconnected
        await onState(state)
        let ceiling = min(30.0, pow(2.0, Double(min(failures, 5))))
        failures = min(failures + 1, 5)
        do {
          try await Task.sleep(for: .seconds(Double.random(in: (ceiling / 2)...ceiling)))
        } catch { break }
      }
    }
    await transport.disconnect()
    state = .stopped
    await onState(state)
  }

  private func heartbeats(
    onState: @Sendable (DeviceConnectionState) async -> Void,
    status: @Sendable () async -> DeviceAvailability
  ) async throws {
    while !Task.isCancelled {
      let availability = await status()
      try Task.checkCancellation()
      try await transport.heartbeat(status: availability.rawValue)
      try Task.checkCancellation()
      state = .connected
      await onState(state)
      failures = 0
      try await Task.sleep(for: .seconds(15))
    }
  }
}
