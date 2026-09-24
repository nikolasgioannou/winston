# Winston desktop proxy

A native SwiftUI menu-bar application for macOS 14 and later. It contains status, a local pause control, permission entrypoints, and opt-in launch at login. It contains no chat, model runtime, embedded account credentials, or automatic permission requests.

Run `bun run build:desktop` from the repository root to build `apps/desktop-macos/dist/Winston Development.app` for the current Mac architecture. The development bundle has a separate identity and an ad-hoc signature; it does not reuse production privacy grants. Release signing, notarization, and updates are separate distribution steps. Do not replace a previously permissioned production app with an ad-hoc build.

`ProxyState` holds transport-independent state. Pausing blocks action eligibility even if a connection update arrives afterward. Sleep invalidates the connection, and wake requires a new connection acknowledgement. `ProxyController` owns platform lifecycle, permission preflights and explicit login-item actions. `ProxyMenu` renders those states. The shell remains disconnected until device pairing and transport integration supply real connection state; it never simulates a successful connection.

`bun run test:native` runs lifecycle fixtures and builds the app in the macOS quality gate. The fixtures require no privacy grants, login registration, Keychain access, or network connection. The packaged app can be opened for menu interaction checks. Enabling launch at login changes macOS Login Items and must be explicitly selected; disabling it unregisters the main app. Permission grants are controlled by macOS. Protected applications may still reject input, and missing permissions must not be treated as successful control.

The selected architectures are Apple Silicon and Intel. Universal release packaging and runtime verification on Intel remain distribution checks; a build on one architecture does not establish compatibility on the other.
