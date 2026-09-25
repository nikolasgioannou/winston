import Foundation

public struct DeviceFileSource: Sendable {
  public let artifactId: String
  public let revision: Int64
  public let size: Int64
  public let sha256: String

  public init(artifactId: String, revision: Int64, size: Int64, sha256: String) throws {
    try self.init([
      "artifactId": artifactId, "revision": revision, "size": size, "sha256": sha256,
    ])
  }

  init(_ value: Any) throws {
    var reader = try WireReader(value)
    artifactId = try reader.identifier("artifactId")
    revision = try reader.number("revision")
    size = try reader.number("size")
    guard size <= 50 * 1024 * 1024 else {
      throw DeviceProtocolError.invalidMessage
    }
    sha256 = try reader.matching("sha256", "^[a-f0-9]{64}$", limit: 64)
    try reader.finish()
  }

  var wireValue: [String: Any] {
    ["artifactId": artifactId, "revision": revision, "size": size, "sha256": sha256]
  }
}
