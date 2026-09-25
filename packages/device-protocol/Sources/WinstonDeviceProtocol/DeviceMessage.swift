import Foundation

public struct ExecutionBinding: Sendable {
  public let executionId: String
  public let taskId: String
  public let taskRevision: Int64

  public init(executionId: String, taskId: String, taskRevision: Int64) {
    self.executionId = executionId
    self.taskId = taskId
    self.taskRevision = taskRevision
  }

  init(_ reader: inout WireReader) throws {
    executionId = try reader.identifier("executionId")
    taskId = try reader.identifier("taskId")
    taskRevision = try reader.number("taskRevision")
  }
}

public enum DevicePayload: Sendable {
  case capabilities([DeviceCapability])
  case heartbeat(status: String)
  case execute(ExecutionBinding, deadline: Int64, operation: DeviceOperation)
  case cancel(ExecutionBinding)
  case reconcile(ExecutionBinding, operation: DeviceOperation)
  case reconciled(ExecutionBinding, state: String, exitCode: Int64?)
  case status(ExecutionBinding, sequence: Int64, state: String, exitCode: Int64?)
  case output(ExecutionBinding, sequence: Int64, stream: String, text: String)
  case file(ExecutionBinding, sequence: Int64, transferId: String, size: Int64, sha256: String)
  case observation(
    ExecutionBinding, sequence: Int64, observationId: String, transferId: String, format: String)
  case error(ExecutionBinding, sequence: Int64, code: String, message: String)

  init(_ value: Any) throws {
    var reader = try WireReader(value)
    let kind = try reader.string("kind", limit: 64)

    switch kind {
    case "capabilities":
      let capabilities = try reader.array("capabilities", maximum: 8).map { value in
        guard let name = value as? String, let capability = DeviceCapability(rawValue: name) else {
          throw DeviceProtocolError.invalidMessage
        }
        return capability
      }
      guard Set(capabilities).count == capabilities.count else {
        throw DeviceProtocolError.invalidMessage
      }
      self = .capabilities(capabilities)
    case "heartbeat":
      self = try .heartbeat(
        status: reader.choice("status", ["ready", "locked", "sleeping", "paused"]))
    case "execute":
      self = try .execute(
        ExecutionBinding(&reader), deadline: reader.number("deadline"),
        operation: DeviceOperation(reader.take("operation")))
    case "cancel":
      self = try .cancel(ExecutionBinding(&reader))
    case "reconcile":
      self = try .reconcile(
        ExecutionBinding(&reader), operation: DeviceOperation(reader.take("operation")))
    case "reconciled":
      let binding = try ExecutionBinding(&reader)
      let state = try reader.choice(
        "state",
        [
          "missing", "conflict", "unavailable", "running", "cancel_requested",
          "uncertain", "succeeded", "failed", "canceled",
        ])
      let exitCode = try reader.exitCode()
      guard
        state == "failed"
          || (state == "succeeded" ? exitCode == nil || exitCode == 0 : exitCode == nil)
      else { throw DeviceProtocolError.invalidMessage }
      self = .reconciled(binding, state: state, exitCode: exitCode)
    case "status":
      self = try .status(
        ExecutionBinding(&reader), sequence: reader.number("sequence"),
        state: reader.choice("state", ["accepted", "running", "succeeded", "failed", "canceled"]),
        exitCode: reader.exitCode())
    case "output":
      self = try .output(
        ExecutionBinding(&reader), sequence: reader.number("sequence"),
        stream: reader.choice("stream", ["stdout", "stderr"]),
        text: reader.string("text", limit: 16_384))
    case "file":
      self = try .file(
        ExecutionBinding(&reader), sequence: reader.number("sequence"),
        transferId: reader.identifier("transferId"), size: reader.number("size"),
        sha256: reader.matching("sha256", "^[0-9a-f]{64}$", limit: 64))
    case "observation":
      self = try .observation(
        ExecutionBinding(&reader), sequence: reader.number("sequence"),
        observationId: reader.identifier("observationId"),
        transferId: reader.identifier("transferId"),
        format: reader.choice("format", ["accessibility", "screenshot"]))
    case "error":
      self = try .error(
        ExecutionBinding(&reader), sequence: reader.number("sequence"),
        code: reader.choice(
          "code",
          ["permission_denied", "unsupported", "unavailable", "stale", "deadline", "failed"]),
        message: reader.string("message", limit: 2000))
    default:
      throw DeviceProtocolError.invalidMessage
    }

    try reader.finish()
  }
}

public struct DeviceMessage: Sendable {
  public static let frameLimit = 262_144
  public let messageId: String
  public let correlationId: String
  public let deviceId: String
  public let sessionId: String
  public let generation: Int64
  public let payload: DevicePayload
  private let data: Data

  public init(data: Data) throws {
    guard data.count <= Self.frameLimit,
      !data.contains(0),
      !data.starts(with: [0xef, 0xbb, 0xbf]),
      String(data: data, encoding: .utf8) != nil
    else {
      throw DeviceProtocolError.invalidMessage
    }
    var reader = try WireReader(JSONSerialization.jsonObject(with: data))
    guard try reader.number("version") == 1 else {
      throw DeviceProtocolError.invalidMessage
    }
    messageId = try reader.identifier("messageId")
    correlationId = try reader.identifier("correlationId")
    deviceId = try reader.identifier("deviceId")
    sessionId = try reader.identifier("sessionId")
    generation = try reader.number("generation")
    payload = try DevicePayload(reader.take("payload"))
    try reader.finish()
    self.data = data
  }

  public init(
    messageId: String, correlationId: String, deviceId: String,
    sessionId: String, generation: Int64, payload: DevicePayload
  ) throws {
    let object: [String: Any] = [
      "version": 1, "messageId": messageId, "correlationId": correlationId,
      "deviceId": deviceId, "sessionId": sessionId, "generation": generation,
      "payload": payload.wireValue,
    ]
    try self.init(data: JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
  }

  public func encoded() -> Data {
    data
  }

  public func acceptsExecution(
    deviceId: String, sessionId: String, generation: Int64,
    taskId: String, taskRevision: Int64, now: Int64,
    capabilities: Set<DeviceCapability>
  ) -> Bool {
    guard case .execute(let binding, let deadline, let operation) = payload else {
      return false
    }
    return self.deviceId == deviceId && self.sessionId == sessionId && self.generation == generation
      && binding.taskId == taskId && binding.taskRevision == taskRevision && deadline > now
      && capabilities.contains(operation.capability)
  }
}
