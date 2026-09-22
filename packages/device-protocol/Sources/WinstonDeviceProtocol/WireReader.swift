import CoreFoundation
import Foundation

public enum DeviceProtocolError: Error {
  case invalidMessage
}

// Consume every field so Codable's default unknown-key tolerance cannot hide version drift.
struct WireReader {
  private var fields: [String: Any]

  init(_ value: Any) throws {
    guard let fields = value as? [String: Any] else {
      throw DeviceProtocolError.invalidMessage
    }
    self.fields = fields
  }

  mutating func take(_ key: String) throws -> Any {
    guard let value = fields.removeValue(forKey: key) else {
      throw DeviceProtocolError.invalidMessage
    }
    return value
  }

  mutating func string(_ key: String, limit: Int, minimum: Int = 0) throws -> String {
    guard let value = try take(key) as? String,
      value.unicodeScalars.count >= minimum,
      value.unicodeScalars.count <= limit,
      !value.contains("\0")
    else {
      throw DeviceProtocolError.invalidMessage
    }
    return value
  }

  mutating func choice(_ key: String, _ choices: [String]) throws -> String {
    let value = try string(key, limit: 64)
    guard choices.contains(value) else {
      throw DeviceProtocolError.invalidMessage
    }
    return value
  }

  mutating func number(_ key: String) throws -> Int64 {
    guard let value = try take(key) as? NSNumber,
      CFGetTypeID(value) != CFBooleanGetTypeID(),
      value.doubleValue >= 0,
      value.doubleValue <= 9_007_199_254_740_991,
      value.doubleValue.rounded(.towardZero) == value.doubleValue
    else {
      throw DeviceProtocolError.invalidMessage
    }
    return value.int64Value
  }

  mutating func boolean(_ key: String) throws -> Bool {
    guard let value = try take(key) as? NSNumber,
      CFGetTypeID(value) == CFBooleanGetTypeID()
    else {
      throw DeviceProtocolError.invalidMessage
    }
    return value.boolValue
  }

  mutating func exitCode() throws -> Int64? {
    let value = try take("exitCode")
    if value is NSNull {
      return nil
    }
    var item = try WireReader(["value": value])
    let code = try item.number("value")
    guard code <= 255 else {
      throw DeviceProtocolError.invalidMessage
    }
    return code
  }

  mutating func matching(_ key: String, _ pattern: String, limit: Int) throws -> String {
    let value = try string(key, limit: limit)
    guard value.range(of: pattern, options: .regularExpression) != nil else {
      throw DeviceProtocolError.invalidMessage
    }
    return value
  }

  mutating func identifier(_ key: String) throws -> String {
    try matching(
      key, "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", limit: 36)
  }

  mutating func path(_ key: String) throws -> String {
    try matching(key, "^/", limit: 4096)
  }

  mutating func array(_ key: String, maximum: Int) throws -> [Any] {
    guard let value = try take(key) as? [Any], value.count <= maximum else {
      throw DeviceProtocolError.invalidMessage
    }
    return value
  }

  func finish() throws {
    guard fields.isEmpty else {
      throw DeviceProtocolError.invalidMessage
    }
  }
}
