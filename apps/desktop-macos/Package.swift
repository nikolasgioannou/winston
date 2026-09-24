// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WinstonDesktop",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "WinstonProxy", targets: ["WinstonProxy"])],
  dependencies: [.package(path: "../../packages/device-transport")],
  targets: [
    .target(name: "ProxyState"),
    .target(
      name: "ProxySession",
      dependencies: [.product(name: "WinstonDeviceTransport", package: "device-transport")]),
    .executableTarget(
      name: "WinstonProxy",
      dependencies: [
        "ProxyState", "ProxySession",
      ]),
    .executableTarget(name: "ShellFixture", dependencies: ["ProxyState"]),
    .executableTarget(name: "SessionFixture", dependencies: ["ProxySession"]),
  ]
)
