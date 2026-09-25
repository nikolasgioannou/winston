import AppKit

@MainActor
final class ProxyApplicationDelegate: NSObject, NSApplicationDelegate {
  let controller = ProxyController()
  private var terminating = false

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if !terminating {
      terminating = true
      Task {
        await controller.shutdown()
        sender.reply(toApplicationShouldTerminate: true)
      }
    }
    return .terminateLater
  }
}
