import Foundation
import WinstonDeviceTransport

private actor LifecycleEvents {
  private(set) var values: [DeviceConnectionState] = []

  func append(_ state: DeviceConnectionState) {
    values.append(state)
  }
}

@main
struct TransportFixture {
  static func main() async throws {
    let deviceId = "11111111-1111-4111-8111-111111111111"
    let credential = "wdi_" + String(repeating: "a", count: 43)
    for address in [
      "ws://example.com/api/devices/socket", "wss://example.com/api/devices/socket?token=bad",
      "wss://user@example.com/api/devices/socket",
    ] {
      do {
        _ = try DeviceTransport(
          endpoint: URL(string: address)!, deviceId: deviceId, credential: credential,
          allowInsecureLoopback: true)
        fatalError("Unsafe endpoint accepted")
      } catch DeviceTransportError.invalidConfiguration {}
    }
    let transport = try DeviceTransport(
      endpoint: URL(string: CommandLine.arguments[1])!, deviceId: deviceId, credential: credential,
      allowInsecureLoopback: true)
    if CommandLine.arguments.count > 2 {
      let mode = CommandLine.arguments[2]
      if mode == "reconnect" || mode == "pairing" {
        let loop = DeviceConnectionLoop(transport: transport)
        let events = LifecycleEvents()
        let operation = Task {
          try await loop.run(onState: { await events.append($0) }, status: { .paused })
        }
        for _ in 0..<100 {
          let state = await loop.state
          if state == .connected || state == .pairingRequired { break }
          try await Task.sleep(for: .milliseconds(50))
        }
        let state = await loop.state
        guard state == (mode == "reconnect" ? .connected : .pairingRequired) else {
          operation.cancel()
          fatalError("Incorrect connection lifecycle")
        }
        operation.cancel()
        try await operation.value
        if mode == "reconnect" {
          guard await loop.state == .stopped else { fatalError("Connection did not stop") }
        }
        let expected: [DeviceConnectionState] =
          mode == "reconnect"
          ? [.connecting, .disconnected, .connecting, .connected, .stopped]
          : [.connecting, .pairingRequired]
        guard await events.values == expected else {
          fatalError("Incorrect lifecycle notifications")
        }
        print("Native connection lifecycle passed")
        return
      }
      let operation = Task {
        _ = try await transport.connect()
        try await transport.heartbeat(status: "paused")
      }
      if mode == "cancel" {
        try await Task.sleep(for: .milliseconds(100))
        operation.cancel()
      }
      do {
        try await operation.value
        fatalError("Invalid connection accepted")
      } catch is DeviceTransportError {
        await transport.disconnect()
        print("Native transport rejected connection")
        return
      }
    }
    let session = try await transport.connect()
    guard session.deviceId == deviceId else { fatalError("Wrong device") }
    try await transport.heartbeat(status: "paused")
    await transport.disconnect()
    print("Native transport handshake and heartbeat passed")
  }
}
