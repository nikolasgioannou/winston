// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WinstonDesktop",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "WinstonProxy", targets: ["WinstonProxy"])],
  dependencies: [
    .package(path: "../../packages/device-transport"),
    .package(path: "../../packages/device-protocol"),
  ],
  targets: [
    .target(name: "ProxyState"),
    .target(
      name: "ProxyJournal",
      dependencies: [.product(name: "WinstonDeviceProtocol", package: "device-protocol")]),
    .target(
      name: "ProxyExecution",
      dependencies: ["ProxyJournal", "ProxyCommands", "ProxyFiles", "ProxyFileTransfer"]),
    .target(name: "ProxyCommands"),
    .target(name: "ProxyFiles"),
    .target(
      name: "ProxyFileTransfer",
      dependencies: [
        "ProxyFiles", .product(name: "WinstonDeviceProtocol", package: "device-protocol"),
      ]),
    .target(
      name: "ProxyRuntime",
      dependencies: [
        "ProxyExecution", "ProxyJournal", "ProxyCommands", "ProxyFiles", "ProxyFileTransfer",
        .product(name: "WinstonDeviceTransport", package: "device-transport"),
      ]),
    .target(
      name: "ProxySession",
      dependencies: [
        "ProxyRuntime", "ProxyFiles", "ProxyFileTransfer",
        .product(name: "WinstonDeviceTransport", package: "device-transport"),
      ]),
    .executableTarget(
      name: "WinstonProxy",
      dependencies: [
        "ProxyState", "ProxySession",
      ]),
    .executableTarget(name: "ShellFixture", dependencies: ["ProxyState"]),
    .executableTarget(name: "SessionFixture", dependencies: ["ProxySession"]),
    .executableTarget(name: "JournalFixture", dependencies: ["ProxyJournal"]),
    .executableTarget(name: "ExecutionFixture", dependencies: ["ProxyExecution"]),
    .executableTarget(name: "CommandFixture", dependencies: ["ProxyCommands"]),
    .executableTarget(name: "FilesFixture", dependencies: ["ProxyFiles"]),
    .executableTarget(name: "FileWritesFixture", dependencies: ["ProxyFiles"]),
    .executableTarget(name: "FileSnapshotsFixture", dependencies: ["ProxyFiles"]),
    .executableTarget(name: "FileUploadFixture", dependencies: ["ProxyFileTransfer"]),
    .executableTarget(name: "FileSessionFixture", dependencies: ["ProxyRuntime"]),
    .executableTarget(
      name: "CommandHandlerFixture", dependencies: ["ProxyExecution", "ProxyCommands"]),
    .executableTarget(name: "CommandSessionFixture", dependencies: ["ProxyRuntime"]),
  ]
)
