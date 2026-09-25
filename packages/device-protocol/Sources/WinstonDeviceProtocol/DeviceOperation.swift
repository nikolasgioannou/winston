import Foundation

public enum DeviceCapability: String, Sendable, CaseIterable {
  case command
  case fileRead = "file.read"
  case fileWrite = "file.write"
  case fileMetadata = "file.metadata"
  case fileList = "file.list"
  case observe
  case input
  case application
}

public enum DeviceOperation: Sendable {
  case command(executable: String, arguments: [String], directory: String)
  case fileRead(path: String, transferId: String)
  case fileWrite(path: String, transferId: String, overwrite: Bool, source: DeviceFileSource)
  case fileMetadata(path: String)
  case fileList(path: String, limit: Int64)
  case observe(application: String, format: String)
  case input(observationId: String, elementId: String, action: String, text: String)
  case application(application: String, action: String, observationId: String)

  public var capability: DeviceCapability {
    switch self {
    case .command: .command
    case .fileRead: .fileRead
    case .fileWrite: .fileWrite
    case .fileMetadata: .fileMetadata
    case .fileList: .fileList
    case .observe: .observe
    case .input: .input
    case .application: .application
    }
  }

  init(_ value: Any) throws {
    var reader = try WireReader(value)
    let kind = try reader.choice("kind", DeviceCapability.allCases.map(\.rawValue))

    switch kind {
    case "command":
      let executable = try reader.path("executable")
      let arguments = try reader.array("arguments", maximum: 128).map { value in
        var item = try WireReader(["value": value])
        return try item.string("value", limit: 8192)
      }
      self = try .command(
        executable: executable, arguments: arguments, directory: reader.path("directory"))
    case "file.read":
      self = try .fileRead(path: reader.path("path"), transferId: reader.identifier("transferId"))
    case "file.write":
      self = try .fileWrite(
        path: reader.path("path"), transferId: reader.identifier("transferId"),
        overwrite: reader.boolean("overwrite"), source: DeviceFileSource(reader.take("source")))
    case "file.metadata":
      self = try .fileMetadata(path: reader.path("path"))
    case "file.list":
      let path = try reader.path("path")
      let limit = try reader.number("limit")
      guard (1...200).contains(limit) else { throw DeviceProtocolError.invalidMessage }
      self = .fileList(path: path, limit: limit)
    case "observe":
      self = try .observe(
        application: reader.string("application", limit: 255, minimum: 1),
        format: reader.choice("format", ["accessibility", "screenshot"]))
    case "input":
      self = try .input(
        observationId: reader.identifier("observationId"),
        elementId: reader.string("elementId", limit: 128, minimum: 1),
        action: reader.choice("action", ["click", "type"]), text: reader.string("text", limit: 8192)
      )
    case "application":
      self = try .application(
        application: reader.string("application", limit: 255, minimum: 1),
        action: reader.choice("action", ["activate", "raise", "close"]),
        observationId: reader.identifier("observationId"))
    default:
      throw DeviceProtocolError.invalidMessage
    }

    try reader.finish()
  }
}
