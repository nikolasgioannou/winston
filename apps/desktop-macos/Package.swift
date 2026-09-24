// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WinstonDesktop",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "WinstonProxy", targets: ["WinstonProxy"])],
  targets: [
    .target(name: "ProxyState"),
    .executableTarget(name: "WinstonProxy", dependencies: ["ProxyState"]),
    .executableTarget(name: "ShellFixture", dependencies: ["ProxyState"]),
  ]
)
