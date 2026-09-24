import Foundation
import Observation
import WinstonDeviceTransport

@MainActor
@Observable
public final class DeviceSessionController {
  public private(set) var name: String?
  public private(set) var origin: URL?
  public private(set) var connection: DeviceConnectionState = .stopped
  public private(set) var error: String?
  public private(set) var changingIdentity = false
  public private(set) var pairingRequired = false
  public private(set) var enabled = true
  private var loaded = false
  private var sleeping = false
  private var paused = false
  @ObservationIgnored private let dependencies: SessionDependencies
  @ObservationIgnored private var identity: StoredDeviceIdentity?
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var revision = 0

  public var isPaired: Bool { identity != nil }

  public convenience init() {
    self.init(dependencies: .live())
  }

  package init(dependencies: SessionDependencies) {
    self.dependencies = dependencies
  }

  public func restore() async {
    guard !changingIdentity, identity == nil else { return }
    guard dependencies.allowed else {
      error = "Pairing requires the signed Winston app."
      return
    }
    changingIdentity = true
    defer { changingIdentity = false }
    do {
      identity = try await dependencies.load()
      loaded = true
      name = identity?.name
      origin = identity?.origin
      error = nil
      restart()
    } catch {
      self.error =
        "Could not read the device identity from Keychain. Try again after unlocking your Mac."
    }
  }

  public func pair(origin address: String, token: String) async {
    guard !changingIdentity, identity == nil else { return }
    if !loaded { await restore() }
    guard loaded, !changingIdentity, identity == nil else { return }
    guard dependencies.allowed else {
      error = "Pairing requires the signed Winston app."
      return
    }
    guard let origin = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
      origin.scheme == "https"
    else {
      error = "Enter the HTTPS address of your Winston web app."
      return
    }
    changingIdentity = true
    error = nil
    defer { changingIdentity = false }
    do {
      let stored = try await dependencies.pair(
        origin, token.trimmingCharacters(in: .whitespacesAndNewlines))
      do {
        try await dependencies.save(stored)
      } catch {
        self.error =
          "Pairing reached Winston, but Keychain could not save it. Remove this computer in the web app and create a new pairing code."
        return
      }
      identity = stored
      name = stored.name
      self.origin = stored.origin
      pairingRequired = false
      enabled = true
      restart()
    } catch {
      self.error =
        "Pairing could not be confirmed. Create a new pairing code in the web app before trying again."
    }
  }

  public func setPaused(_ paused: Bool) {
    self.paused = paused
    restart()
  }

  public func setSleeping(_ sleeping: Bool) {
    self.sleeping = sleeping
    restart()
  }

  public func setEnabled(_ enabled: Bool) {
    guard !changingIdentity else { return }
    self.enabled = enabled
    restart()
  }

  public func forget() async {
    guard !changingIdentity else { return }
    changingIdentity = true
    defer { changingIdentity = false }
    enabled = false
    restart()
    await operation?.value
    do {
      try await dependencies.remove()
      identity = nil
      name = nil
      origin = nil
      pairingRequired = false
      error = nil
    } catch {
      self.error =
        "Could not remove the identity from Keychain. This computer remains disconnected."
    }
  }

  private func restart() {
    revision += 1
    let current = revision
    let previous = operation
    previous?.cancel()
    connection = .stopped
    let identity = identity
    operation = Task { [weak self] in
      // Join the obsolete loop before opening another session with the same credential.
      await previous?.value
      guard let self, !Task.isCancelled, self.revision == current,
        self.enabled, !self.sleeping, !self.pairingRequired, let identity
      else { return }
      do {
        try await self.dependencies.run(
          identity,
          { [weak self] state in
            await self?.receive(state, revision: current)
          },
          { [weak self] in
            await self?.availability() ?? .paused
          })
      } catch {
        guard self.revision == current else { return }
        self.connection = .disconnected
        self.error = "Could not start the connection."
      }
    }
  }

  private func availability() -> DeviceAvailability {
    if sleeping { return .sleeping }
    return paused ? .paused : .ready
  }

  private func receive(_ state: DeviceConnectionState, revision: Int) {
    guard self.revision == revision else { return }
    connection = state
    if state == .pairingRequired {
      pairingRequired = true
      error = "This computer's access was revoked. Forget this pairing before connecting again."
    }
  }
}
