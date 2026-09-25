import Foundation
import ProxyFileTransfer
import ProxyFiles
import ProxyRuntime
import WinstonDeviceTransport

@MainActor
package struct SessionDependencies {
  var allowed: Bool
  var load: () async throws -> StoredDeviceIdentity?
  var save: (StoredDeviceIdentity) async throws -> Void
  var remove: () async throws -> Void
  var pair: (URL, String) async throws -> StoredDeviceIdentity
  var run:
    (
      StoredDeviceIdentity,
      @escaping @Sendable (DeviceConnectionState) async -> Void,
      @escaping @Sendable () async -> DeviceAvailability
    ) async throws -> Void

  package init(
    allowed: Bool,
    load: @escaping () async throws -> StoredDeviceIdentity?,
    save: @escaping (StoredDeviceIdentity) async throws -> Void,
    remove: @escaping () async throws -> Void,
    pair: @escaping (URL, String) async throws -> StoredDeviceIdentity,
    run:
      @escaping (
        StoredDeviceIdentity,
        @escaping @Sendable (DeviceConnectionState) async -> Void,
        @escaping @Sendable () async -> DeviceAvailability
      ) async throws -> Void
  ) {
    self.allowed = allowed
    self.load = load
    self.save = save
    self.remove = remove
    self.pair = pair
    self.run = run
  }

  static func live() -> Self {
    let store = KeychainIdentityStore()
    return Self(
      allowed: Bundle.main.bundleIdentifier == "app.runwinston.proxy",
      load: { try await store.load() },
      save: { try await store.save($0) },
      remove: { try await store.remove() },
      pair: { origin, token in
        // Execution capabilities are advertised only after their handlers are installed.
        let device = try await DevicePairing.pair(
          origin: origin, token: token,
          appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
            ?? "0.1.0",
          capabilities: [])
        return try StoredDeviceIdentity(
          origin: origin, deviceId: device.id, name: device.name, credential: device.credential)
      },
      run: { identity, onState, status in
        var endpoint = URLComponents(url: identity.origin, resolvingAgainstBaseURL: false)!
        endpoint.scheme = "wss"
        endpoint.path = "/api/devices/socket"
        let transport = try DeviceTransport(
          endpoint: endpoint.url!, deviceId: identity.deviceId, credential: identity.credential)
        let files = FileManager.default
        let support = try files.url(
          for: .applicationSupportDirectory, in: .userDomainMask,
          appropriateFor: nil, create: true)
        let runtime = ExecutionConnection(
          directory: support.appendingPathComponent("app.runwinston.proxy", isDirectory: true),
          environment: [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": files.homeDirectoryForCurrentUser.path,
            "TMPDIR": files.temporaryDirectory.path,
          ],
          fileReads: FileReadConfiguration(
            uploader: try DeviceFileUploader(
              origin: identity.origin, deviceId: identity.deviceId,
              credential: identity.credential),
            // Server approval binds each read to its exact path; macOS permissions still apply.
            root: try FileRoot(path: "/")),
          fileWrites: FileWriteConfiguration(
            downloader: try DeviceFileDownloader(
              origin: identity.origin, deviceId: identity.deviceId,
              credential: identity.credential),
            // Each write separately binds the destination, collision policy and source bytes.
            root: try FileWriteRoot(path: "/")))
        try await runtime.run(transport: transport, onState: onState, status: status)
      })
  }
}
