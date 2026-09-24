import ServiceManagement
import SwiftUI

struct ProxyMenu: View {
  @Environment(\.openWindow) private var openWindow
  let controller: ProxyController

  var body: some View {
    Text(status)
      .accessibilityIdentifier("proxy-status")
    if let name = controller.session.name { Text(name) }
    Button(controller.session.isPaired ? "Connection…" : "Connect to Winston…") {
      openWindow(id: "connection")
      NSApplication.shared.activate()
    }
    Button(controller.state.isPaused ? "Resume" : "Pause") {
      controller.togglePause()
    }
    Divider()
    Menu("Permissions") {
      Button(controller.accessibilityAllowed ? "Accessibility allowed" : "Allow Accessibility…") {
        controller.requestAccessibility()
      }
      .disabled(controller.accessibilityAllowed)
      Button(
        controller.screenCaptureAllowed ? "Screen Recording allowed" : "Allow Screen Recording…"
      ) {
        controller.requestScreenCapture()
      }
      .disabled(controller.screenCaptureAllowed)
      Button("Refresh status") { controller.refresh() }
    }
    Button(loginTitle) {
      Task { await controller.toggleLogin() }
    }
    .disabled(controller.changingLogin)
    if controller.loginStatus == .requiresApproval {
      Button("Approve in Login Items…") { controller.openLoginSettings() }
    }
    if let error = controller.loginError { Text(error) }
    Divider()
    Button("Quit Winston") { controller.quit() }
      .keyboardShortcut("q")
  }

  private var status: String {
    if controller.session.pairingRequired { return "Pairing required" }
    if controller.state.isSleeping { return "Sleeping" }
    if controller.state.isPaused { return "Paused" }
    switch controller.session.connection {
    case .stopped, .disconnected: return "Disconnected"
    case .connecting: return "Connecting"
    case .connected: return "Connected"
    case .pairingRequired: return "Pairing required"
    }
  }

  private var loginTitle: String {
    switch controller.loginStatus {
    case .enabled: "Disable launch at login"
    case .requiresApproval: "Cancel launch at login"
    default: "Launch at login"
    }
  }
}
