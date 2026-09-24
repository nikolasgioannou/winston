import Foundation

/// Pipe chunks need not end at a UTF-8 boundary. Only an incomplete suffix is retained.
package struct CommandTextDecoder {
  private var pending: [UInt8] = []

  package init() {}

  package mutating func append(_ data: Data, final: Bool = false) -> String {
    pending.append(contentsOf: data)
    var boundary = pending.count
    if !final && !pending.isEmpty {
      for offset in 1...min(4, pending.count) {
        let index = pending.count - offset
        let byte = pending[index]
        if (0x80...0xbf).contains(byte) { continue }
        let expected: Int
        switch byte {
        case 0xc2...0xdf: expected = 2
        case 0xe0...0xef: expected = 3
        case 0xf0...0xf4: expected = 4
        default: expected = 1
        }
        if offset < expected { boundary = index }
        break
      }
    }
    let text = String(decoding: pending.prefix(boundary), as: UTF8.self)
      .replacingOccurrences(of: "\0", with: "\u{fffd}")
    pending = Array(pending.suffix(pending.count - boundary))
    return text
  }
}
