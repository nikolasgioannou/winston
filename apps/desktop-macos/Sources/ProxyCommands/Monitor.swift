import Darwin
import Foundation

/// Nil means inspection failed or exceeded its bound; it is never interpreted as an empty group.
private func hasLiveMembers(_ pid: pid_t) -> Bool? {
  var members = [pid_t](repeating: 0, count: 4096)
  let size = members.count * MemoryLayout<pid_t>.size
  let count = members.withUnsafeMutableBytes {
    proc_listpids(UInt32(PROC_PGRP_ONLY), UInt32(pid), $0.baseAddress, Int32($0.count))
  }
  guard count > 0, count < size, count % Int32(MemoryLayout<pid_t>.size) == 0 else { return nil }
  for member in members.prefix(Int(count) / MemoryLayout<pid_t>.size) where member > 0 {
    var info = proc_bsdinfo()
    let received = proc_pidinfo(
      member, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    if received == 0 && errno == ESRCH { continue }
    guard received == MemoryLayout<proc_bsdinfo>.size else { return nil }
    if info.pbi_pgid == UInt32(pid) && info.pbi_status != SZOMB { return true }
  }
  return false
}

func monitor(
  command: Command, cancellation: CommandCancellation,
  output: AsyncStream<CommandOutput>.Continuation, outputLimit: Int
) throws -> CommandResult {
  if cancellation.isCanceled || command.deadline <= Date() {
    return CommandResult(
      exitCode: nil, signal: nil,
      stopReason: cancellation.isCanceled ? .canceled : .deadline, uncertain: false)
  }
  let child = try spawn(command)
  defer {
    close(child.stdout)
    close(child.stderr)
  }
  var reaped = false
  defer {
    if !reaped {
      // Only this exact, unreaped child gives authority to use this process-group ID.
      kill(-child.pid, SIGKILL)
      kill(child.pid, SIGKILL)
      var status: Int32 = 0
      while waitpid(child.pid, &status, 0) == -1 && errno == EINTR {}
    }
  }
  var stop: CommandResult.StopReason?
  var uncertain = false
  var total = 0
  var stdoutOpen = true
  var stderrOpen = true
  var cleanup: ContinuousClock.Instant?
  var killed = false
  var exited: siginfo_t?
  let clock = ContinuousClock()

  func signalGroup(_ signal: Int32) {
    // Darwin may return EPERM for a group containing only the waitable zombie.
    if exited == nil || hasLiveMembers(child.pid) != false {
      if kill(-child.pid, signal) != 0 && errno != ESRCH {
        if errno != EPERM || hasLiveMembers(child.pid) != false { uncertain = true }
      }
    }
    // A group leader can deliberately leave its initial group. Its PID is still owned.
    if exited == nil && getpgid(child.pid) != child.pid && kill(child.pid, signal) != 0
      && errno != ESRCH
    {
      uncertain = true
    }
  }

  func drain(_ descriptor: Int32, stream: CommandOutput.Stream, isOpen: inout Bool) {
    guard isOpen else { return }
    var bytes = [UInt8](repeating: 0, count: 4096)
    // Bound each turn so continuous output cannot starve cancellation or wait checks.
    for _ in 0..<8 {
      let count = read(descriptor, &bytes, bytes.count)
      if count == 0 {
        isOpen = false
        return
      }
      if count < 0 {
        if errno == EAGAIN || errno == EINTR { return }
        isOpen = false
        stop = stop ?? .ioFailure
        return
      }
      guard total <= outputLimit - count else {
        stop = stop ?? .outputLimit
        continue
      }
      total += count
      switch output.yield(CommandOutput(stream: stream, bytes: Data(bytes.prefix(count)))) {
      case .enqueued: break
      case .dropped: stop = stop ?? .outputLimit
      case .terminated: stop = stop ?? .outputClosed
      @unknown default: stop = stop ?? .ioFailure
      }
    }
  }

  while true {
    if stop == nil && cancellation.isCanceled { stop = .canceled }
    if stop == nil && command.deadline <= Date() { stop = .deadline }
    drain(child.stdout, stream: .stdout, isOpen: &stdoutOpen)
    drain(child.stderr, stream: .stderr, isOpen: &stderrOpen)
    if exited == nil {
      var info = siginfo_t()
      if waitid(P_PID, id_t(child.pid), &info, WEXITED | WNOHANG | WNOWAIT) != 0 {
        if errno == EINTR { continue }
        // Lost wait ownership: never signal a potentially recycled PID.
        reaped = true
        return CommandResult(exitCode: nil, signal: nil, stopReason: stop, uncertain: true)
      }
      if info.si_pid == child.pid { exited = info }
    }
    if (stop != nil || exited != nil) && cleanup == nil {
      cleanup = clock.now
      signalGroup(SIGTERM)
    }
    if let cleanup {
      if !killed && cleanup.duration(to: clock.now) >= .seconds(1) {
        signalGroup(SIGKILL)
        killed = true
      }
      if exited != nil {
        let live = hasLiveMembers(child.pid)
        if live == nil { uncertain = true }
        if live == false && !stdoutOpen && !stderrOpen { break }
        // Escaped descendants may retain a pipe; do not wait forever or call that clean completion.
        if killed && cleanup.duration(to: clock.now) >= .seconds(3) {
          uncertain = true
          break
        }
      }
    }
    usleep(20_000)
  }

  var status: Int32 = 0
  var waited: pid_t
  repeat { waited = waitpid(child.pid, &status, 0) } while waited == -1 && errno == EINTR
  reaped = true
  guard waited == child.pid, let exited else {
    return CommandResult(exitCode: nil, signal: nil, stopReason: stop, uncertain: true)
  }
  return CommandResult(
    exitCode: exited.si_code == CLD_EXITED ? exited.si_status : nil,
    signal: exited.si_code == CLD_EXITED ? nil : exited.si_status,
    stopReason: stop, uncertain: uncertain)
}
