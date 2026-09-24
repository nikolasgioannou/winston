import Foundation
import WinstonDeviceTransport

@main
struct IdentityFixture {
  static func identity(_ name: String = "Fixture Mac") throws -> StoredDeviceIdentity {
    try StoredDeviceIdentity(
      origin: URL(string: "https://example.invalid")!,
      deviceId: "11111111-1111-4111-8111-111111111111", name: name,
      credential: "wdi_" + String(repeating: "a", count: 43))
  }

  static func main() async throws {
    if CommandLine.arguments.count == 1 {
      let original = try identity()
      let data = try JSONEncoder().encode(original)
      let restored = try StoredDeviceIdentity.decode(data)
      guard restored.deviceId == original.deviceId, restored.credential == original.credential
      else { fatalError("Identity roundtrip failed") }
      let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      for change: [String: Any] in [
        ["version": 2], ["origin": "http://example.invalid"], ["deviceId": "invalid"],
        ["credential": "invalid"], ["name": "Bad\nname"],
        ["origin": "https://user@example.invalid"],
      ] {
        let changed = try JSONSerialization.data(
          withJSONObject: object.merging(change) { _, new in new })
        guard (try? StoredDeviceIdentity.decode(changed)) == nil else {
          fatalError("Invalid identity accepted")
        }
      }
      guard (try? StoredDeviceIdentity.decode(Data(repeating: 32, count: 16_385))) == nil else {
        fatalError("Oversized identity accepted")
      }
      print("Native identity validation passed; Keychain untouched")
      return
    }

    guard ProcessInfo.processInfo.environment["WINSTON_ALLOW_KEYCHAIN_FIXTURE"] == "1",
      CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--keychain",
      let identifier = UUID(uuidString: CommandLine.arguments[2])
    else { fatalError("Explicit Keychain fixture authorization required") }
    let store = KeychainIdentityStore(validationIdentifier: identifier)
    switch CommandLine.arguments[3] {
    case "write": try await store.save(identity())
    case "update": try await store.save(identity("Updated fixture"))
    case "read":
      guard try await store.load()?.name == "Fixture Mac" else {
        fatalError("Keychain readback failed")
      }
    case "read-updated":
      guard try await store.load()?.name == "Updated fixture" else {
        fatalError("Keychain update failed")
      }
    case "remove": try await store.remove()
    case "missing":
      guard try await store.load() == nil else { fatalError("Keychain cleanup failed") }
    default: fatalError("Unknown fixture operation")
    }
    print("Keychain fixture operation passed")
  }
}
