public enum ProxyConnection: Equatable, Sendable {
  case disconnected, connecting, connected
}

public struct ProxyState: Equatable, Sendable {
  public private(set) var connection: ProxyConnection = .disconnected
  public private(set) var isPaused = false
  public private(set) var isSleeping = false

  public init() {}

  public var acceptsActions: Bool {
    connection == .connected && !isPaused && !isSleeping
  }

  public var label: String {
    if isPaused { return "Paused" }
    if isSleeping { return "Sleeping" }
    switch connection {
    case .disconnected: return "Disconnected"
    case .connecting: return "Connecting"
    case .connected: return "Connected"
    }
  }

  public mutating func setConnection(_ connection: ProxyConnection) {
    self.connection = connection
  }

  public mutating func setPaused(_ paused: Bool) {
    isPaused = paused
  }

  public mutating func sleep() {
    isSleeping = true
    connection = .disconnected
  }

  public mutating func wake() {
    isSleeping = false
    connection = .disconnected
  }
}
