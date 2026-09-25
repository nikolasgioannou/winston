import SwiftUI

@main
struct WinstonProxyApp: App {
  @NSApplicationDelegateAdaptor(ProxyApplicationDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra("Winston", systemImage: "desktopcomputer") {
      ProxyMenu(controller: delegate.controller)
    }
    Window("Winston connection", id: "connection") {
      ConnectionView(session: delegate.controller.session)
    }
    .windowResizability(.contentSize)
  }
}
