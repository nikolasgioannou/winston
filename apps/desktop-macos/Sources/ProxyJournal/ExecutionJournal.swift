import CryptoKit
import Foundation
import SQLite3
import WinstonDeviceProtocol

/// Persist admission before starting an effect. A storage error closes the journal;
/// callers must stop admission rather than fall back to an in-memory record.
public actor ExecutionJournal {
  private let database: JournalDatabase

  /// The caller supplies an existing, owner-only directory. Do not delete the database
  /// to repair an error: its retained records are the duplicate-execution barrier.
  public init(directory: URL) throws {
    database = try JournalDatabase(directory: directory)
  }

  public func close() { database.close() }

  public func hasUncertainExecution(deviceId: String) throws -> Bool {
    guard UUID(uuidString: deviceId) != nil else { throw JournalError.invalidRequest }
    do {
      return try database.query(
        "SELECT 1 FROM executions WHERE device_id = ? AND state = 'uncertain' LIMIT 1",
        values: [deviceId.lowercased()], read: { _ in true }
      ).first ?? false
    } catch {
      database.close()
      throw error
    }
  }

  public func admit(_ message: DeviceMessage) throws -> JournalAdmission {
    guard case .execute(let binding, _, _) = message.payload else {
      throw JournalError.invalidRequest
    }
    let key = try JournalKey(deviceId: message.deviceId, executionId: binding.executionId)
    let fingerprint = try fingerprint(message)

    if let existing = try record(key) {
      guard existing.fingerprint == fingerprint else { throw JournalError.conflictingExecution }
      return .existing(existing)
    }

    try write(
      """
      INSERT INTO executions(device_id, execution_id, fingerprint, state)
      VALUES (?, ?, ?, 'running')
      """, values: [key.deviceId, key.executionId, fingerprint])
    return .admitted(
      JournalRecord(
        key: key, fingerprint: fingerprint, state: .running,
        cancellationRequested: false, exitCode: nil))
  }

  public func record(_ key: JournalKey) throws -> JournalRecord? {
    do {
      return try database.query(
        """
        SELECT fingerprint, state, exit_code, cancellation_requested FROM executions
        WHERE device_id = ? AND execution_id = ?
        """,
        values: [key.deviceId, key.executionId]
      ) { statement in
        guard let fingerprint = sqlite3_column_text(statement, 0),
          let stateText = sqlite3_column_text(statement, 1),
          let state = JournalState(rawValue: String(cString: stateText))
        else { throw JournalError.unavailable }
        return JournalRecord(
          key: key, fingerprint: String(cString: fingerprint), state: state,
          cancellationRequested: sqlite3_column_int(statement, 3) == 1,
          exitCode: sqlite3_column_type(statement, 2) == SQLITE_NULL
            ? nil : sqlite3_column_int64(statement, 2))
      }.first
    } catch {
      database.close()
      throw error
    }
  }

  /// A request is not proof that cancellation succeeded or that no effect occurred.
  public func requestCancellation(_ key: JournalKey) throws -> JournalRecord {
    guard let current = try record(key) else { throw JournalError.invalidTransition }
    guard current.state == .running else { return current }
    try write(
      """
      UPDATE executions SET state = 'cancel_requested', cancellation_requested = 1
      WHERE device_id = ? AND execution_id = ?
      """,
      values: [key.deviceId, key.executionId])
    return JournalRecord(
      key: key, fingerprint: current.fingerprint, state: .cancelRequested,
      cancellationRequested: true, exitCode: nil)
  }

  public func finish(_ key: JournalKey, state: JournalState, exitCode: Int64? = nil) throws
    -> JournalRecord
  {
    guard state.isTerminal, exitCode.map({ (0...255).contains($0) }) ?? true,
      let current = try record(key)
    else { throw JournalError.invalidTransition }

    if current.state.isTerminal {
      guard current.state == state && current.exitCode == exitCode else {
        throw JournalError.conflictingExecution
      }
      return current
    }
    guard current.state == .running || current.state == .cancelRequested else {
      throw JournalError.invalidTransition
    }
    try write(
      "UPDATE executions SET state = ?, exit_code = ? WHERE device_id = ? AND execution_id = ?",
      values: [state.rawValue, exitCode.map(String.init), key.deviceId, key.executionId])
    return JournalRecord(
      key: key, fingerprint: current.fingerprint, state: state,
      cancellationRequested: current.cancellationRequested, exitCode: exitCode)
  }

  public func markUncertain(_ key: JournalKey) throws -> JournalRecord {
    guard let current = try record(key) else { throw JournalError.invalidTransition }
    guard !current.state.isTerminal && current.state != .uncertain else { return current }
    try write(
      "UPDATE executions SET state = 'uncertain' WHERE device_id = ? AND execution_id = ?",
      values: [key.deviceId, key.executionId])
    return JournalRecord(
      key: key, fingerprint: current.fingerprint, state: .uncertain,
      cancellationRequested: current.cancellationRequested, exitCode: nil)
  }

  private func write(_ sql: String, values: [String?]) throws {
    do {
      try database.execute(sql, values: values)
    } catch {
      // A failed commit may have reached storage. Reopen/reconcile; never retry an effect here.
      database.close()
      throw error
    }
  }

  private func fingerprint(_ message: DeviceMessage) throws -> String {
    guard
      let envelope = try JSONSerialization.jsonObject(with: message.encoded()) as? [String: Any],
      var payload = envelope["payload"] as? [String: Any]
    else { throw JournalError.invalidRequest }
    // A reconnect can change transport IDs and deadline, never the bound task or operation.
    payload.removeValue(forKey: "deadline")
    let canonical = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    return SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined()
  }
}
