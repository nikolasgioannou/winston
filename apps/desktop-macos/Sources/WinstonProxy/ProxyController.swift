import AppKit
@preconcurrency import ApplicationServices
import Observation
import ProxyState
import ServiceManagement

@MainActor
@Observable
final class ProxyController {
  private(set) var state = ProxyState()
  private(set) var accessibilityAllowed = false
  private(set) var screenCaptureAllowed = false
  private(set) var loginStatus = SMAppService.mainApp.status
  private(set) var loginError: String?
  private(set) var changingLogin = false
  @ObservationIgnored private var observers: [NSObjectProtocol] = []

  init() {
    refresh()
    let center = NSWorkspace.shared.notificationCenter
    observers.append(
      center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.state.sleep() }
      })
    observers.append(
      center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated {
          self?.state.wake()
          self?.refresh()
        }
      })
  }

  func refresh() {
    accessibilityAllowed = AXIsProcessTrusted()
    screenCaptureAllowed = CGPreflightScreenCaptureAccess()
    loginStatus = SMAppService.mainApp.status
  }

  func togglePause() {
    state.setPaused(!state.isPaused)
  }

  func requestAccessibility() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    refresh()
  }

  func requestScreenCapture() {
    _ = CGRequestScreenCaptureAccess()
    refresh()
  }

  func toggleLogin() async {
    guard !changingLogin else { return }
    changingLogin = true
    loginError = nil
    defer {
      changingLogin = false
      refresh()
    }
    do {
      switch SMAppService.mainApp.status {
      case .enabled, .requiresApproval:
        try await SMAppService.mainApp.unregister()
      case .notRegistered, .notFound:
        try SMAppService.mainApp.register()
      @unknown default:
        loginError = "Check Login Items in System Settings."
      }
    } catch {
      loginError = "Could not change launch at login. Check System Settings."
    }
  }

  func openLoginSettings() {
    SMAppService.openSystemSettingsLoginItems()
  }

  func quit() {
    state.setPaused(true)
    NSApplication.shared.terminate(nil)
  }
}
