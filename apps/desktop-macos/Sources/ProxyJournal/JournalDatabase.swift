import Darwin
import Foundation
import SQLite3

/// Owned exclusively by ExecutionJournal. Its file lock also excludes other processes.
final class JournalDatabase {
  private var database: OpaquePointer?
  private var descriptor: Int32 = -1

  init(directory: URL) throws {
    guard directory.isFileURL else { throw JournalError.unavailable }
    var directoryInfo = stat()
    guard lstat(directory.path, &directoryInfo) == 0,
      directoryInfo.st_mode & S_IFMT == S_IFDIR,
      directoryInfo.st_uid == geteuid(), directoryInfo.st_mode & 0o077 == 0
    else {
      throw JournalError.unavailable
    }

    let path = directory.appendingPathComponent("executions.sqlite").path
    let lockPath = directory.appendingPathComponent("executions.lock").path
    descriptor = open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw JournalError.unavailable }

    do {
      _ = try validateFile(descriptor)
      guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw JournalError.alreadyOpen }
      // Keep the process-ownership lock separate from SQLite's own database locks.
      let fileDescriptor = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard fileDescriptor >= 0 else { throw JournalError.unavailable }
      let file: stat
      do {
        file = try validateFile(fileDescriptor)
      } catch {
        Darwin.close(fileDescriptor)
        throw error
      }
      Darwin.close(fileDescriptor)
      guard
        sqlite3_open_v2(path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
          == SQLITE_OK
      else {
        throw JournalError.unavailable
      }
      var opened = stat()
      guard lstat(path, &opened) == 0, opened.st_ino == file.st_ino, opened.st_dev == file.st_dev
      else {
        throw JournalError.unavailable
      }

      try execute("PRAGMA journal_mode = DELETE")
      try execute("PRAGMA synchronous = EXTRA")
      try execute("PRAGMA fullfsync = ON")
      try execute("PRAGMA trusted_schema = OFF")
      let version = try query("PRAGMA user_version") { sqlite3_column_int($0, 0) }.first
      guard version == 0 || version == 1 else { throw JournalError.unavailable }

      if version == 0 {
        let tables = try query("SELECT count(*) FROM sqlite_master") {
          sqlite3_column_int($0, 0)
        }.first
        guard tables == 0 else { throw JournalError.unavailable }
        try execute("BEGIN IMMEDIATE")
        try execute(
          """
          CREATE TABLE executions (
            device_id TEXT NOT NULL,
            execution_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
            state TEXT NOT NULL CHECK(state IN
              ('running', 'cancel_requested', 'uncertain', 'succeeded', 'failed', 'canceled')),
            exit_code INTEGER,
            cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_requested IN (0, 1)),
            PRIMARY KEY(device_id, execution_id)
          ) STRICT
          """)
        try execute("PRAGMA user_version = 1")
        try execute("COMMIT")
      }

      let integrity = try query("PRAGMA quick_check") { statement in
        String(cString: sqlite3_column_text(statement, 0))
      }
      guard integrity == ["ok"] else { throw JournalError.unavailable }
      // Only the lock owner may recover. Nothing left in flight is safe to replay.
      try execute(
        "UPDATE executions SET state = 'uncertain' WHERE state IN ('running', 'cancel_requested')")
    } catch {
      close()
      throw error
    }
  }

  deinit { close() }

  func close() {
    if let database {
      sqlite3_close_v2(database)
      self.database = nil
    }
    if descriptor >= 0 {
      Darwin.close(descriptor)
      descriptor = -1
    }
  }

  func execute(_ sql: String, values: [String?] = []) throws {
    try statement(sql, values: values) { statement in
      while true {
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return }
        guard result == SQLITE_ROW else { throw JournalError.unavailable }
      }
    }
  }

  func query<T>(
    _ sql: String, values: [String?] = [], read: (OpaquePointer) throws -> T
  ) throws -> [T] {
    try statement(sql, values: values) { statement in
      var rows: [T] = []
      while true {
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return rows }
        guard result == SQLITE_ROW else { throw JournalError.unavailable }
        rows.append(try read(statement))
      }
    }
  }

  private func statement<T>(
    _ sql: String, values: [String?], body: (OpaquePointer) throws -> T
  ) throws -> T {
    guard let database else { throw JournalError.unavailable }
    var prepared: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else {
      throw JournalError.unavailable
    }
    defer { sqlite3_finalize(prepared) }

    for (offset, value) in values.enumerated() {
      let index = Int32(offset + 1)
      let result: Int32
      if let value {
        result = value.withCString {
          sqlite3_bind_text(
            prepared, index, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
      } else {
        result = sqlite3_bind_null(prepared, index)
      }
      guard result == SQLITE_OK else { throw JournalError.unavailable }
    }
    return try body(prepared)
  }

  private func validateFile(_ descriptor: Int32) throws -> stat {
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      info.st_uid == geteuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0
    else { throw JournalError.unavailable }
    return info
  }
}
