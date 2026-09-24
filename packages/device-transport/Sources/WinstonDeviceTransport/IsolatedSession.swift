import Foundation

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

func isolatedSession(resourceTimeout: TimeInterval? = nil) -> URLSession {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.httpCookieStorage = nil
  configuration.httpShouldSetCookies = false
  configuration.urlCredentialStorage = nil
  configuration.urlCache = nil
  if let resourceTimeout { configuration.timeoutIntervalForResource = resourceTimeout }
  return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
}
