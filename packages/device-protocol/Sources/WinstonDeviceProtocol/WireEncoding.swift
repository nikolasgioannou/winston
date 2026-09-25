import Foundation

extension ExecutionBinding {
  var wireValue: [String: Any] {
    ["executionId": executionId, "taskId": taskId, "taskRevision": taskRevision]
  }
}

extension DeviceOperation {
  var wireValue: [String: Any] {
    switch self {
    case .command(let executable, let arguments, let directory):
      ["kind": "command", "executable": executable, "arguments": arguments, "directory": directory]
    case .fileRead(let path, let transferId):
      ["kind": "file.read", "path": path, "transferId": transferId]
    case .fileWrite(let path, let transferId, let overwrite, let source):
      [
        "kind": "file.write", "path": path, "transferId": transferId, "overwrite": overwrite,
        "source": source.wireValue,
      ]
    case .fileMetadata(let path):
      ["kind": "file.metadata", "path": path]
    case .fileList(let path, let limit):
      ["kind": "file.list", "path": path, "limit": limit]
    case .observe(let application, let format):
      ["kind": "observe", "application": application, "format": format]
    case .input(let observationId, let elementId, let action, let text):
      [
        "kind": "input", "observationId": observationId, "elementId": elementId, "action": action,
        "text": text,
      ]
    case .application(let application, let action, let observationId):
      [
        "kind": "application", "application": application, "action": action,
        "observationId": observationId,
      ]
    }
  }
}

extension DevicePayload {
  var wireValue: [String: Any] {
    switch self {
    case .capabilities(let capabilities):
      return ["kind": "capabilities", "capabilities": capabilities.map(\.rawValue)]
    case .heartbeat(let status):
      return ["kind": "heartbeat", "status": status]
    case .execute(let binding, let deadline, let operation):
      return binding.wireValue.merging([
        "kind": "execute", "deadline": deadline, "operation": operation.wireValue,
      ]) { _, new in new }
    case .cancel(let binding):
      return binding.wireValue.merging(["kind": "cancel"]) { _, new in new }
    case .reconcile(let binding, let operation):
      return binding.wireValue.merging([
        "kind": "reconcile", "operation": operation.wireValue,
      ]) { _, new in new }
    case .reconciled(let binding, let state, let exitCode):
      return binding.wireValue.merging([
        "kind": "reconciled", "state": state,
        "exitCode": exitCode.map { $0 as Any } ?? NSNull(),
      ]) { _, new in new }
    case .status(let binding, let sequence, let state, let exitCode):
      return binding.wireValue.merging([
        "kind": "status", "sequence": sequence, "state": state,
        "exitCode": exitCode.map { $0 as Any } ?? NSNull(),
      ]) { _, new in new }
    case .output(let binding, let sequence, let stream, let text):
      return binding.wireValue.merging([
        "kind": "output", "sequence": sequence, "stream": stream, "text": text,
      ]) { _, new in new }
    case .file(let binding, let sequence, let transferId, let size, let sha256):
      return binding.wireValue.merging([
        "kind": "file", "sequence": sequence, "transferId": transferId,
        "size": size, "sha256": sha256,
      ]) { _, new in new }
    case .observation(let binding, let sequence, let observationId, let transferId, let format):
      return binding.wireValue.merging([
        "kind": "observation", "sequence": sequence, "observationId": observationId,
        "transferId": transferId, "format": format,
      ]) { _, new in new }
    case .error(let binding, let sequence, let code, let message):
      return binding.wireValue.merging([
        "kind": "error", "sequence": sequence, "code": code, "message": message,
      ]) { _, new in new }
    }
  }
}
