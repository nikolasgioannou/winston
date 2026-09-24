import Foundation
import WinstonDeviceProtocol

public enum DeviceTransportError: Error {
  case invalidConfiguration
  case invalidSession
  case unavailable
  case pairingRequired
  case busy
}

public actor DeviceTransport {
  private let endpoint: URL
  private let deviceId: String
  private let credential: String
  private let client: URLSession
  private var socket: URLSessionWebSocketTask?
  private var channel: DeviceChannel?
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
    client = isolatedSession()
  }

  deinit { client.invalidateAndCancel() }

  public func connect() async throws -> DeviceSession {
    guard !busy else { throw DeviceTransportError.busy }
    busy = true
    defer { busy = false }
    await disconnect()
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
      let connected = DeviceChannel(socket: task, session: welcome)
      channel = connected
      await connected.start()
      return welcome
    } catch {
      if socket === task { await disconnect() }
      if let response = task.response as? HTTPURLResponse, [401, 403].contains(response.statusCode)
      {
        throw DeviceTransportError.pairingRequired
      }
      throw DeviceTransportError.unavailable
    }
  }

  public func heartbeat(status: String) async throws {
    guard !busy else { throw DeviceTransportError.busy }
    guard let channel else { throw DeviceTransportError.unavailable }
    busy = true
    defer { busy = false }
    try await channel.sendHeartbeat(status: status)
  }

  /// Exactly one consumer may await operations for the active connection.
  public func receiveOperation(session: DeviceSession) async throws -> DeviceMessage {
    let channel = try activeChannel(session)
    return try await channel.receiveOperation()
  }

  public func send(_ payload: DevicePayload, correlationId: String, session: DeviceSession)
    async throws
  {
    let channel = try activeChannel(session)
    try await channel.send(payload, correlationId: correlationId)
  }

  public func waitForDisconnect(session: DeviceSession) async throws {
    let channel = try activeChannel(session)
    try await channel.waitForDisconnect()
  }

  private func activeChannel(_ session: DeviceSession) throws -> DeviceChannel {
    guard let channel, channel.session.deviceId == session.deviceId,
      channel.session.sessionId == session.sessionId,
      channel.session.generation == session.generation
    else { throw DeviceTransportError.unavailable }
    return channel
  }

  public func disconnect() async {
    let prior = channel
    channel = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    await prior?.close()
  }
}

private func receive(_ task: URLSessionWebSocketTask) async throws
  -> String
{
  try await withTaskCancellationHandler {
    try await withThrowingTaskGroup(of: String.self) { group in
      group.addTask {
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
