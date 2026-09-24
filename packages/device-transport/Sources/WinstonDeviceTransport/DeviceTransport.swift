import Foundation
import WinstonDeviceProtocol

public enum DeviceTransportError: Error {
  case invalidConfiguration
  case invalidSession
  case unavailable
  case pairingRequired
  case busy
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

public actor DeviceTransport {
  private let endpoint: URL
  private let deviceId: String
  private let credential: String
  private let client: URLSession
  private var socket: URLSessionWebSocketTask?
  private var session: DeviceSession?
  private var busy = false

  public init(
    endpoint: URL, deviceId: String, credential: String, allowInsecureLoopback: Bool = false
  ) throws {
    let loopback = ["127.0.0.1", "localhost", "[::1]"].contains(endpoint.host ?? "")
    guard
      endpoint.scheme == "wss" || (allowInsecureLoopback && endpoint.scheme == "ws" && loopback),
      endpoint.host != nil, endpoint.user == nil, endpoint.password == nil,
      endpoint.query == nil, endpoint.fragment == nil, endpoint.path == "/api/devices/socket",
      UUID(uuidString: deviceId) != nil, deviceId == deviceId.lowercased(),
      credential.range(of: "^wdi_[A-Za-z0-9_-]{43}\\z", options: .regularExpression) != nil
    else { throw DeviceTransportError.invalidConfiguration }
    self.endpoint = endpoint
    self.deviceId = deviceId
    self.credential = credential
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    client = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
  }

  deinit { client.invalidateAndCancel() }

  public func connect() async throws -> DeviceSession {
    guard !busy else { throw DeviceTransportError.busy }
    busy = true
    defer { busy = false }
    disconnect()
    var request = URLRequest(url: endpoint)
    request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
    let task = client.webSocketTask(with: request)
    task.maximumMessageSize = DeviceMessage.frameLimit
    socket = task
    task.resume()
    do {
      let raw = try await receive(task)
      let welcome = try DeviceSession(data: Data(raw.utf8))
      guard socket === task, welcome.deviceId == deviceId else {
        throw DeviceTransportError.invalidSession
      }
      session = welcome
      return welcome
    } catch {
      if socket === task { disconnect() }
      if let response = task.response as? HTTPURLResponse, [401, 403].contains(response.statusCode)
      {
        throw DeviceTransportError.pairingRequired
      }
      throw DeviceTransportError.unavailable
    }
  }

  public func heartbeat(status: String) async throws {
    guard !busy else { throw DeviceTransportError.busy }
    guard let task = socket, let current = session else { throw DeviceTransportError.unavailable }
    busy = true
    defer { busy = false }
    do {
      let message = try DeviceMessage(
        messageId: UUID().uuidString.lowercased(), correlationId: UUID().uuidString.lowercased(),
        deviceId: current.deviceId, sessionId: current.sessionId, generation: current.generation,
        payload: .heartbeat(status: status))
      guard let text = String(data: message.encoded(), encoding: .utf8) else {
        throw DeviceTransportError.invalidSession
      }
      let raw = try await receive(task, sending: text)
      let reply = try DeviceMessage(data: Data(raw.utf8))
      guard socket === task, reply.deviceId == current.deviceId,
        reply.sessionId == current.sessionId, reply.generation == current.generation,
        reply.correlationId == message.messageId,
        case .heartbeat(let acknowledged) = reply.payload, acknowledged == status
      else { throw DeviceTransportError.invalidSession }
    } catch {
      if socket === task { disconnect() }
      throw DeviceTransportError.unavailable
    }
  }

  public func disconnect() {
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    session = nil
  }
}

private func receive(_ task: URLSessionWebSocketTask, sending text: String? = nil) async throws
  -> String
{
  try await withTaskCancellationHandler {
    try await withThrowingTaskGroup(of: String.self) { group in
      group.addTask {
        if let text { try await task.send(.string(text)) }
        guard case .string(let value) = try await task.receive() else {
          throw DeviceTransportError.invalidSession
        }
        return value
      }
      group.addTask {
        try await Task.sleep(for: .seconds(10))
        task.cancel(with: .goingAway, reason: nil)
        throw DeviceTransportError.unavailable
      }
      defer { group.cancelAll() }
      guard let value = try await group.next() else { throw DeviceTransportError.unavailable }
      return value
    }
  } onCancel: {
    task.cancel(with: .goingAway, reason: nil)
  }
}
