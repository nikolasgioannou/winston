import ServiceManagement
import SwiftUI

struct ProxyMenu: View {
  let controller: ProxyController

  var body: some View {
    Text(controller.state.label)
      .accessibilityIdentifier("proxy-status")
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

  private var loginTitle: String {
    switch controller.loginStatus {
    case .enabled: "Disable launch at login"
    case .requiresApproval: "Cancel launch at login"
    default: "Launch at login"
    }
  }
}
