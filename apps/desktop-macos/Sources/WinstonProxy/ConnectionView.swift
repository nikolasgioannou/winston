import ProxySession
import SwiftUI

struct ConnectionView: View {
  let session: DeviceSessionController
  @State private var address = "https://winston-628.fly.dev"
  @State private var token = ""
  @State private var confirmingForget = false

  var body: some View {
    Form {
      if session.isPaired {
        LabeledContent("Computer", value: session.name ?? "")
        LabeledContent("Winston", value: session.origin?.absoluteString ?? "")
        if !session.pairingRequired {
          Button(session.enabled ? "Disconnect" : "Reconnect") {
            session.setEnabled(!session.enabled)
          }
          .disabled(session.changingIdentity)
        }
        Button("Forget pairing…", role: .destructive) { confirmingForget = true }
          .disabled(session.changingIdentity)
      } else {
        TextField("Winston address", text: $address)
        SecureField("Pairing code", text: $token)
        Text("Create a pairing code in Computers in your Winston web app.")
          .foregroundStyle(.secondary)
        Button(session.changingIdentity ? "Connecting…" : "Connect") {
          let code = token
          token = ""
          Task { await session.pair(origin: address, token: code) }
        }
        .disabled(session.changingIdentity || token.isEmpty)
      }
      if let error = session.error {
        Text(error).foregroundStyle(.secondary)
        if !session.isPaired {
          Button("Retry Keychain") { Task { await session.restore() } }
            .disabled(session.changingIdentity)
        }
      }
    }
    .formStyle(.grouped)
    .frame(width: 440)
    .fixedSize(horizontal: false, vertical: true)
    .confirmationDialog("Forget this computer's pairing?", isPresented: $confirmingForget) {
      Button("Forget pairing", role: .destructive) {
        Task { await session.forget() }
      }
    } message: {
      Text(
        "This removes the saved credential from this Mac. Remove the computer in the web app to revoke its access there too."
      )
    }
  }
}
