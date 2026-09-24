import Foundation

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

  public init(transport: DeviceTransport) {
    self.transport = transport
  }

  public func run(status: @Sendable () async -> DeviceAvailability) async throws {
    guard !running else { throw DeviceTransportError.busy }
    running = true
    defer { running = false }
    var failures = 0
    while !Task.isCancelled {
      do {
        state = .connecting
        _ = try await transport.connect()
        while !Task.isCancelled {
          let availability = await status()
          try Task.checkCancellation()
          try await transport.heartbeat(status: availability.rawValue)
          state = .connected
          failures = 0
          try await Task.sleep(for: .seconds(15))
        }
      } catch DeviceTransportError.pairingRequired {
        await transport.disconnect()
        state = Task.isCancelled ? .stopped : .pairingRequired
        return
      } catch {
        await transport.disconnect()
        if Task.isCancelled { break }
        state = .disconnected
        let ceiling = min(30.0, pow(2.0, Double(min(failures, 5))))
        failures = min(failures + 1, 5)
        do {
          try await Task.sleep(for: .seconds(Double.random(in: (ceiling / 2)...ceiling)))
        } catch { break }
      }
    }
    await transport.disconnect()
    state = .stopped
  }
}
