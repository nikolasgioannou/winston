import Foundation
import WinstonDeviceTransport

@main
struct PairingFixture {
  static func main() async throws {
    let rejected = CommandLine.arguments.count > 2
    do {
      let device = try await DevicePairing.pair(
        origin: URL(string: CommandLine.arguments[1])!,
        token: "wdp_" + String(repeating: "b", count: 43), appVersion: "0.1.0",
        capabilities: [], allowInsecureLoopback: true)
      guard !rejected, device.id == "11111111-1111-4111-8111-111111111111",
        device.name == "Fixture Mac",
        device.credential == "wdi_" + String(repeating: "a", count: 43)
      else { fatalError("Unexpected pairing response") }
      print("Native pairing passed")
    } catch is DeviceTransportError {
      guard rejected else { fatalError("Pairing fixture failed") }
      print("Native pairing rejected")
    }
  }
}
