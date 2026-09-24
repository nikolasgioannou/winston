import Foundation

public struct DeviceSession: Sendable {
  public let deviceId: String
  public let sessionId: String
  public let generation: Int64
  public let expiresAt: String

  public init(data: Data) throws {
    guard data.count <= DeviceMessage.frameLimit,
      !data.contains(0),
      !data.starts(with: [0xef, 0xbb, 0xbf]),
      String(data: data, encoding: .utf8) != nil
    else {
      throw DeviceProtocolError.invalidMessage
    }
    var reader = try WireReader(JSONSerialization.jsonObject(with: data))
    guard try reader.number("version") == 1,
      try reader.choice("kind", ["session"]) == "session"
    else {
      throw DeviceProtocolError.invalidMessage
    }
    deviceId = try reader.identifier("deviceId")
    sessionId = try reader.identifier("sessionId")
    generation = try reader.number("generation")
    expiresAt = try reader.matching(
      "expiresAt", "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z\\z",
      limit: DeviceMessage.frameLimit)
    guard generation > 0, Self.validDate(expiresAt) else {
      throw DeviceProtocolError.invalidMessage
    }
    try reader.finish()
  }

  private static func validDate(_ value: String) -> Bool {
    let parts = value.prefix(19).split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    guard parts.count == 6 else { return false }
    let year = parts[0]
    let month = parts[1]
    let day = parts[2]
    let leap = year % 400 == 0 || (year % 4 == 0 && year % 100 != 0)
    let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return (1...12).contains(month) && (1...days[month - 1]).contains(day)
      && parts[3] < 24 && parts[4] < 60 && parts[5] < 60
  }
}
