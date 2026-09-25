import ProxyJournal
import WinstonDeviceProtocol

package protocol JournalStore: Actor {
  func hasUncertainExecution() async throws -> Bool
  func admit(_ message: DeviceMessage) async throws -> JournalAdmission
  func requestCancellation(_ key: JournalKey) async throws -> JournalRecord
  func finish(_ key: JournalKey, state: JournalState, exitCode: Int64?) async throws
    -> JournalRecord
  func markUncertain(_ key: JournalKey) async throws -> JournalRecord
}

extension ExecutionJournal: JournalStore {}
