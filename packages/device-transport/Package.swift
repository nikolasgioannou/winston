// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WinstonDeviceTransport",
  platforms: [.macOS(.v14)],
  products: [.library(name: "WinstonDeviceTransport", targets: ["WinstonDeviceTransport"])],
  dependencies: [.package(path: "../device-protocol")],
  targets: [
    .target(
      name: "WinstonDeviceTransport",
      dependencies: [.product(name: "WinstonDeviceProtocol", package: "device-protocol")]),
    .executableTarget(name: "TransportFixture", dependencies: ["WinstonDeviceTransport"]),
  ]
)
