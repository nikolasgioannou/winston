import Darwin
import Foundation

struct SpawnedCommand {
  let pid: pid_t
  let stdout: Int32
  let stderr: Int32
}

private func check(_ code: Int32) throws {
  if code != 0 { throw CommandError.system(code) }
}

private func outputPipe() throws -> [Int32] {
  var descriptors: [Int32] = [0, 0]
  guard pipe(&descriptors) == 0 else { throw CommandError.system(errno) }
  do {
    for index in descriptors.indices {
      if descriptors[index] < 3 {
        let replacement = fcntl(descriptors[index], F_DUPFD_CLOEXEC, 3)
        guard replacement >= 0 else { throw CommandError.system(errno) }
        close(descriptors[index])
        descriptors[index] = replacement
      }
      guard fcntl(descriptors[index], F_SETFD, FD_CLOEXEC) == 0 else {
        throw CommandError.system(errno)
      }
    }
    guard fcntl(descriptors[0], F_SETFL, O_NONBLOCK) == 0 else { throw CommandError.system(errno) }
    return descriptors
  } catch {
    for descriptor in descriptors { close(descriptor) }
    throw error
  }
}

func spawn(_ command: Command) throws -> SpawnedCommand {
  let stdout = try outputPipe()
  var keepReads = false
  defer {
    close(stdout[1])
    if !keepReads { close(stdout[0]) }
  }
  let stderr = try outputPipe()
  defer {
    close(stderr[1])
    if !keepReads { close(stderr[0]) }
  }
  var actions: posix_spawn_file_actions_t?
  try check(posix_spawn_file_actions_init(&actions))
  defer { posix_spawn_file_actions_destroy(&actions) }
  try check(posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0))
  try check(posix_spawn_file_actions_adddup2(&actions, stdout[1], STDOUT_FILENO))
  try check(posix_spawn_file_actions_adddup2(&actions, stderr[1], STDERR_FILENO))
  // The non-suffixed spelling also requires a macOS 26 SDK at compile time.
  // Keep the spelling available in our minimum supported SDK, including native CI.
  try check(posix_spawn_file_actions_addchdir_np(&actions, command.directory))

  var attributes: posix_spawnattr_t?
  try check(posix_spawnattr_init(&attributes))
  defer { posix_spawnattr_destroy(&attributes) }
  try check(
    posix_spawnattr_setflags(
      &attributes,
      Int16(
        POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF
          | POSIX_SPAWN_SETSIGMASK)))
  try check(posix_spawnattr_setpgroup(&attributes, 0))
  var signals = sigset_t()
  sigemptyset(&signals)
  try check(posix_spawnattr_setsigmask(&attributes, &signals))
  sigfillset(&signals)
  try check(posix_spawnattr_setsigdefault(&attributes, &signals))

  var arguments = ([command.executable] + command.arguments).map { strdup($0) }
  var environment = command.environment.sorted { $0.key < $1.key }.map {
    strdup("\($0.key)=\($0.value)")
  }
  defer {
    for value in arguments { free(value) }
    for value in environment { free(value) }
  }
  guard arguments.allSatisfy({ $0 != nil }), environment.allSatisfy({ $0 != nil }) else {
    throw CommandError.system(ENOMEM)
  }
  arguments.append(nil)
  environment.append(nil)
  var pid: pid_t = 0
  try check(posix_spawn(&pid, command.executable, &actions, &attributes, &arguments, &environment))
  // This child remains unreaped until the monitor has stopped signaling its group.
  keepReads = true
  return SpawnedCommand(pid: pid, stdout: stdout[0], stderr: stderr[0])
}
