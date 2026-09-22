import Foundation
import WinstonDeviceProtocol

func require(_ condition: Bool, _ name: String) {
  guard condition else {
    fatalError("Protocol fixture failed: \(name)")
  }
}

let path = CommandLine.arguments[1]
let data = try Data(contentsOf: URL(fileURLWithPath: path))
let fixtures = try JSONSerialization.jsonObject(with: data) as! [String: Any]

for group in ["valid", "invalid"] {
  for fixture in fixtures[group] as! [[String: Any]] {
    let name = fixture["name"] as! String
    let frame = try JSONSerialization.data(withJSONObject: fixture["message"]!)
    let accepted = (try? DeviceMessage(data: frame)) != nil
    require(accepted == (group == "valid"), name)
    if accepted {
      let decoded = try DeviceMessage(data: frame)
      let rebuilt = try DeviceMessage(
        messageId: decoded.messageId, correlationId: decoded.correlationId,
        deviceId: decoded.deviceId, sessionId: decoded.sessionId,
        generation: decoded.generation, payload: decoded.payload
      )
      let original = try JSONSerialization.jsonObject(with: frame) as! NSDictionary
      let encoded = try JSONSerialization.jsonObject(with: rebuilt.encoded()) as! NSDictionary
      require(original == encoded, "\(name) roundtrip")
    }
  }
}

for frame in fixtures["rawInvalid"] as! [String] {
  require((try? DeviceMessage(data: Data(frame.utf8))) == nil, "invalid raw frame")
}

let valid = fixtures["valid"] as! [[String: Any]]
let command = valid[2]["message"]!
let frame = try JSONSerialization.data(withJSONObject: command)
let message = try DeviceMessage(data: frame)
let id = "11111111-1111-4111-8111-111111111111"

func accepts(
  device: String = id, session: String = id, generation: Int64 = 2,
  task: String = id, revision: Int64 = 3, now: Int64 = 1000,
  capabilities: Set<DeviceCapability> = [.command]
) -> Bool {
  message.acceptsExecution(
    deviceId: device, sessionId: session, generation: generation,
    taskId: task, taskRevision: revision, now: now, capabilities: capabilities
  )
}

require(accepts(), "current execution")
require(!accepts(device: "other"), "different device")
require(!accepts(session: "other"), "different session")
require(!accepts(generation: 3), "stale generation")
require(!accepts(task: "other"), "different task")
require(!accepts(revision: 4), "stale task revision")
require(!accepts(now: 2000), "expired deadline")
require(!accepts(capabilities: []), "missing capability")

var oversized = frame
oversized.append(Data(repeating: 32, count: DeviceMessage.frameLimit))
require((try? DeviceMessage(data: oversized)) == nil, "oversized frame")
require((try? DeviceMessage(data: Data("{".utf8))) == nil, "malformed JSON")
require((try? DeviceMessage(data: Data([0xff]))) == nil, "invalid UTF-8")
print("Swift protocol fixtures and execution binding checks passed")
