import Foundation

/// One 64 KiB chunk connects the network delegate to the synchronous file writer.
/// Both sides run off the UI thread; cancellation wakes either blocked side.
final class FileDownloadPipe: @unchecked Sendable {
  private let condition = NSCondition()
  private let deadline: ContinuousClock.Instant
  private var chunk: Data?
  private var error: Error?
  private var completed = false

  init(timeout: Double) {
    deadline = ContinuousClock.now.advanced(by: .seconds(timeout))
  }

  func fail(_ error: Error) {
    condition.lock()
    if self.error == nil { self.error = error }
    chunk = nil
    condition.broadcast()
    condition.unlock()
  }

  func finish() {
    condition.lock()
    completed = true
    condition.broadcast()
    condition.unlock()
  }

  func put(_ data: Data) throws {
    condition.lock()
    defer { condition.unlock() }
    while chunk != nil { try wait() }
    try check()
    guard !completed else { throw DeviceFileDownloadError.invalidResponse }
    chunk = data
    condition.broadcast()
  }

  func next() throws -> Data? {
    condition.lock()
    defer { condition.unlock() }
    while chunk == nil && !completed { try wait() }
    try check()
    let result = chunk
    chunk = nil
    condition.broadcast()
    return result
  }

  private func check() throws {
    if let error { throw error }
    if ContinuousClock.now >= deadline { throw DeviceFileDownloadError.deadline }
  }

  private func wait() throws {
    try check()
    // Short timed waits keep the monotonic deadline independent of wall-clock changes.
    _ = condition.wait(until: Date(timeIntervalSinceNow: 0.1))
    try check()
  }
}
