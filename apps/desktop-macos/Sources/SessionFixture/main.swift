import Foundation
import ProxySession
import WinstonDeviceTransport

@MainActor
private final class SessionHarness {
  let identity = try! StoredDeviceIdentity(
    origin: URL(string: "https://example.com")!,
    deviceId: "11111111-1111-4111-8111-111111111111", name: "Test Mac",
    credential: "wdi_" + String(repeating: "a", count: 43))
  var saved: StoredDeviceIdentity?
  var starts = 0
  var active = 0
  var maximumActive = 0
  var statuses: [DeviceAvailability] = []
  var reject = false
  var saveFails = false
  var loadFails = false
  var removeFails = false
  var pairCalls = 0

  func dependencies(allowed: Bool = true) -> SessionDependencies {
    SessionDependencies(
      allowed: allowed,
      load: {
        if self.loadFails { throw DeviceIdentityError.keychainStatus(-1) }
        return self.saved
      },
      save: {
        if self.saveFails { throw DeviceIdentityError.keychainStatus(-1) }
        self.saved = $0
      },
      remove: {
        if self.removeFails { throw DeviceIdentityError.keychainStatus(-1) }
        self.saved = nil
      },
      pair: { _, _ in
        self.pairCalls += 1
        return self.identity
      },
      run: { _, onState, status in
        self.starts += 1
        self.active += 1
        self.maximumActive = max(self.active, self.maximumActive)
        defer { self.active -= 1 }
        await onState(.connecting)
        if self.reject {
          await onState(.pairingRequired)
          return
        }
        self.statuses.append(await status())
        await onState(.connected)
        do { try await Task.sleep(for: .seconds(60)) } catch {}
        // Simulate a late notification from a canceled connection.
        await onState(.connected)
      })
  }
}

@main
@MainActor
struct DeviceSessionTests {
  static func main() async throws {
    let tests = Self()
    try await tests.testRestartJoinsOldSessionAndSuppressesStaleCallbacks()
    try await tests.testRevocationDoesNotReconnectOnWakeOrResume()
    try await tests.testPairingPersistsBeforeConnectingAndRestoresLabels()
    await tests.testPersistenceFailureDoesNotConnectOrRetryPairing()
    try await tests.testFailedForgetRetainsIdentityButStopsConnection()
    await tests.testDevelopmentBundleCannotAccessIdentityOrPair()
    await tests.testUnreadableIdentityCannotBeOverwritten()
    print("Native session integration checks passed")
  }

  private func waitFor(_ condition: () -> Bool) async throws {
    for _ in 0..<200 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(5))
    }
    fatalError("Session did not reach the expected state")
  }

  func testRestartJoinsOldSessionAndSuppressesStaleCallbacks() async throws {
    let harness = SessionHarness()
    harness.saved = harness.identity
    let session = DeviceSessionController(dependencies: harness.dependencies())
    await session.restore()
    try await waitFor { session.connection == .connected }
    session.setPaused(true)
    try await waitFor { harness.starts == 2 && session.connection == .connected }
    precondition(harness.statuses == [.ready, .paused])
    session.setSleeping(true)
    try await waitFor { harness.active == 0 }
    precondition(session.connection == .stopped)
    session.setSleeping(false)
    try await waitFor { harness.starts == 3 && session.connection == .connected }
    precondition(harness.statuses.last == .paused)
    precondition(harness.maximumActive == 1)
    session.setEnabled(false)
    session.setSleeping(true)
    session.setSleeping(false)
    try await waitFor { harness.active == 0 }
    precondition(harness.starts == 3)
    precondition(session.connection == .stopped)
  }

  func testRevocationDoesNotReconnectOnWakeOrResume() async throws {
    let harness = SessionHarness()
    harness.saved = harness.identity
    harness.reject = true
    let session = DeviceSessionController(dependencies: harness.dependencies())
    await session.restore()
    try await waitFor { session.pairingRequired }
    session.setSleeping(true)
    session.setSleeping(false)
    session.setPaused(false)
    await session.forget()
    precondition(harness.starts == 1)
    precondition(!session.isPaired)
    precondition(harness.saved == nil)
  }

  func testPairingPersistsBeforeConnectingAndRestoresLabels() async throws {
    let harness = SessionHarness()
    let session = DeviceSessionController(dependencies: harness.dependencies())
    await session.pair(origin: "https://example.com", token: "test")
    precondition(harness.saved != nil)
    try await waitFor { session.connection == .connected }
    session.setEnabled(false)
    try await waitFor { harness.active == 0 }
    let restored = DeviceSessionController(dependencies: harness.dependencies())
    await restored.restore()
    precondition(restored.name == "Test Mac")
    precondition(restored.origin == harness.identity.origin)
    await restored.forget()
    precondition(harness.saved == nil)
  }

  func testPersistenceFailureDoesNotConnectOrRetryPairing() async {
    let harness = SessionHarness()
    harness.saveFails = true
    let session = DeviceSessionController(dependencies: harness.dependencies())
    await session.pair(origin: "https://example.com", token: "test")
    precondition(!session.isPaired)
    precondition(harness.pairCalls == 1)
    precondition(harness.starts == 0)
    precondition(session.error != nil)
  }

  func testFailedForgetRetainsIdentityButStopsConnection() async throws {
    let harness = SessionHarness()
    harness.saved = harness.identity
    harness.removeFails = true
    let session = DeviceSessionController(dependencies: harness.dependencies())
    await session.restore()
    try await waitFor { session.connection == .connected }
    await session.forget()
    precondition(session.isPaired)
    precondition(!session.enabled)
    precondition(harness.active == 0)
    precondition(session.error != nil)
  }

  func testDevelopmentBundleCannotAccessIdentityOrPair() async {
    let harness = SessionHarness()
    harness.saved = harness.identity
    let session = DeviceSessionController(dependencies: harness.dependencies(allowed: false))
    await session.restore()
    await session.pair(origin: "https://example.com", token: "test")
    precondition(!session.isPaired)
    precondition(harness.starts == 0)
    precondition(harness.pairCalls == 0)
  }

  func testUnreadableIdentityCannotBeOverwritten() async {
    let harness = SessionHarness()
    harness.saved = harness.identity
    harness.loadFails = true
    let session = DeviceSessionController(dependencies: harness.dependencies())
    await session.pair(origin: "https://example.com", token: "test")
    precondition(harness.pairCalls == 0)
    precondition(harness.saved != nil)
    precondition(session.error != nil)
    harness.loadFails = false
    await session.restore()
    precondition(session.isPaired)
    await session.forget()
  }
}
