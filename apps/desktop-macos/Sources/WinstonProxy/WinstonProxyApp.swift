import SwiftUI

@main
struct WinstonProxyApp: App {
  @State private var controller = ProxyController()

  var body: some Scene {
    MenuBarExtra("Winston", systemImage: "desktopcomputer") {
      ProxyMenu(controller: controller)
    }
  }
}
