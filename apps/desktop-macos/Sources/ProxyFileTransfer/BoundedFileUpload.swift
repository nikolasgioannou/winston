import Foundation

/// One upload per instance. Delegate callbacks bound response memory before decoding.
final class BoundedFileUpload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Data, Error>?
  private var task: URLSessionUploadTask?
  private var canceled = false
  private var accepted = false
  private var bytes = Data()

  static func send(_ request: URLRequest, file: URL, timeout: Double) async throws -> Data {
    let delegate = BoundedFileUpload()
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
      return try await withCheckedThrowingContinuation { continuation in
        delegate.start(session, request: request, file: file, continuation: continuation)
      }
    } onCancel: {
      delegate.cancel()
    }
  }

  private func start(
    _ session: URLSession, request: URLRequest, file: URL,
    continuation: CheckedContinuation<Data, Error>
  ) {
    lock.lock()
    if canceled {
      lock.unlock()
      continuation.resume(throwing: CancellationError())
      return
    }
    self.continuation = continuation
    let task = session.uploadTask(with: request, fromFile: file)
    self.task = task
    lock.unlock()
    task.resume()
  }

  private func cancel() {
    lock.lock()
    canceled = true
    let task = task
    lock.unlock()
    // Wait for task completion before allowing the snapshot to be removed.
    task?.cancel()
  }

  private func finish(_ result: Result<Data, Error>) {
    lock.lock()
    let continuation = continuation
    self.continuation = nil
    task = nil
    lock.unlock()
    continuation?.resume(with: result)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
      http.mimeType == "application/json", response.expectedContentLength <= 4096
    else {
      completionHandler(.cancel)
      return
    }
    lock.lock()
    accepted = true
    lock.unlock()
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    let oversized = bytes.count + data.count > 4096
    if !oversized { bytes.append(data) }
    if oversized { accepted = false }
    lock.unlock()
    if oversized { dataTask.cancel() }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let accepted = accepted
    let canceled = canceled
    let bytes = bytes
    lock.unlock()
    if canceled {
      finish(.failure(CancellationError()))
    } else if error != nil || !accepted {
      finish(.failure(DeviceFileUploadError.uncertain))
    } else {
      finish(.success(bytes))
    }
  }
}
