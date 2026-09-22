// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WinstonDeviceProtocol",
  platforms: [.macOS(.v14)],
  products: [.library(name: "WinstonDeviceProtocol", targets: ["WinstonDeviceProtocol"])],
  targets: [
    .target(name: "WinstonDeviceProtocol"),
    .executableTarget(name: "ProtocolFixtures", dependencies: ["WinstonDeviceProtocol"]),
  ]
)
