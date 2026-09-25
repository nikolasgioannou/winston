import Foundation
import ProxyFiles
import WinstonDeviceProtocol

final class BoundedFileDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private let source: DeviceFileSource
  private let pipe: FileDownloadPipe
  private var continuation: CheckedContinuation<Void, Error>?
  private var task: URLSessionDataTask?
  private var canceled = false
  // URLSession serializes delegate callbacks; these fields are delegate-only.
  private var accepted = false
  private var received: Int64 = 0

  init(source: DeviceFileSource, pipe: FileDownloadPipe) {
    self.source = source
    self.pipe = pipe
  }

  static func receive(
    _ request: URLRequest, source: DeviceFileSource, timeout: Double,
    root: FileWriteRoot, path: String, transferId: UUID, overwrite: Bool
  ) async throws -> FileWriteReceipt {
    let pipe = FileDownloadPipe(timeout: timeout)
    let delegate = BoundedFileDownload(source: source, pipe: pipe)
    let cancellation = FileCancellation()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForResource = timeout
    configuration.timeoutIntervalForRequest = timeout
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      let writer = Task.detached {
        do {
          return try root.write(
            path: path, transferId: transferId, size: source.size, sha256: source.sha256,
            collision: overwrite ? .replace : .createOnly, timeout: timeout,
            cancellation: cancellation, next: { try pipe.next() })
        } catch {
          delegate.cancel(error)
          throw error
        }
      }
      do { try await delegate.send(session, request: request) } catch { pipe.fail(error) }
      // Join both sides. A successful atomic publication remains successful even if
      // task cancellation arrives afterward; uncertain publication errors propagate.
      return try await writer.value
    } onCancel: {
      cancellation.cancel()
      delegate.cancel(CancellationError())
    }
  }

  private func send(_ session: URLSession, request: URLRequest) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      lock.lock()
      if canceled {
        lock.unlock()
        continuation.resume(throwing: CancellationError())
        return
      }
      self.continuation = continuation
      let task = session.dataTask(with: request)
      self.task = task
      lock.unlock()
      task.resume()
    }
  }

  private func cancel(_ error: Error) {
    pipe.fail(error)
    lock.lock()
    canceled = true
    let task = task
    lock.unlock()
    task?.cancel()
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
      http.mimeType == "application/octet-stream",
      http.expectedContentLength == -1 || http.expectedContentLength == source.size,
      http.value(forHTTPHeaderField: "Content-Encoding") == nil,
      matchesFileSource(http.value(forHTTPHeaderField: "X-Winston-File"), source: source)
    else {
      pipe.fail(DeviceFileDownloadError.invalidResponse)
      completionHandler(.cancel)
      return
    }
    accepted = true
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard accepted, Int64(data.count) <= source.size - received else {
      cancel(DeviceFileDownloadError.invalidResponse)
      return
    }
    received += Int64(data.count)
    do {
      for offset in stride(from: 0, to: data.count, by: 65_536) {
        try pipe.put(data.subdata(in: offset..<min(offset + 65_536, data.count)))
      }
    } catch { cancel(error) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let result: Result<Void, Error>
    if let error {
      result = .failure(error)
    } else if !accepted || received != source.size {
      result = .failure(DeviceFileDownloadError.invalidResponse)
    } else {
      result = .success(())
    }
    switch result {
    case .success: pipe.finish()
    case .failure(let error): pipe.fail(error)
    }
    lock.lock()
    let continuation = continuation
    self.continuation = nil
    self.task = nil
    lock.unlock()
    continuation?.resume(with: result)
  }
}

private struct DownloadDescriptor: Decodable {
  struct Source: Decodable {
    let artifactId: String
    let revision: Int64
    let size: Int64
    let sha256: String
  }
  let version: Int64
  let source: Source
}

private func matchesFileSource(_ header: String?, source: DeviceFileSource) -> Bool {
  guard let header, header.utf8.count <= 4096,
    header.range(of: "^[A-Za-z0-9_-]+\\z", options: .regularExpression) != nil
  else { return false }
  let base = header.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
    of: "_", with: "/")
  let padded = base + String(repeating: "=", count: (4 - base.count % 4) % 4)
  guard let bytes = Data(base64Encoded: padded),
    let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    Set(object.keys) == ["version", "source"],
    let fields = object["source"] as? [String: Any],
    Set(fields.keys) == ["artifactId", "revision", "size", "sha256"],
    let descriptor = try? JSONDecoder().decode(DownloadDescriptor.self, from: bytes)
  else { return false }
  return descriptor.version == 1 && descriptor.source.artifactId == source.artifactId
    && descriptor.source.revision == source.revision && descriptor.source.size == source.size
    && descriptor.source.sha256 == source.sha256
}
