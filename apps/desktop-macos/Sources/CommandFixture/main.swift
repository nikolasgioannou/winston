import Darwin
import Foundation
import ProxyCommands

private struct Captured: Sendable {
  var stdout = Data()
  var stderr = Data()
}

private func capture(_ execution: CommandExecution) -> Task<Captured, Never> {
  Task {
    var result = Captured()
    for await output in execution.output {
      switch output.stream {
      case .stdout: result.stdout.append(output.bytes)
      case .stderr: result.stderr.append(output.bytes)
      }
    }
    return result
  }
}

@main
struct CommandFixture {
  static func main() async throws {
    guard let resolved = realpath(CommandLine.arguments[1], nil) else {
      fatalError("Fixture directory unavailable")
    }
    let directory = String(cString: resolved)
    free(resolved)
    func command(_ script: String, arguments: [String] = [], timeout: Double = 10) throws -> Command
    {
      try Command(
        executable: "/bin/sh", arguments: ["-c", script, "fixture"] + arguments,
        directory: directory,
        environment: ["PATH": "/usr/bin:/bin", "WINSTON_FIXTURE": "explicit"],
        deadline: Date().addingTimeInterval(timeout))
    }

    let literal = "$(touch should-not-exist); * ' \""
    let basic = try CommandExecution(
      command: command(
        "printf '%s\\n' \"$1\" \"$PWD\" \"$WINSTON_FIXTURE\" \"${WINSTON_PARENT_ONLY-unset}\"; printf error >&2; exit 7",
        arguments: [literal]))
    let basicOutput = capture(basic)
    let basicResult = try await basic.result()
    let basicBytes = await basicOutput.value
    precondition(
      basicResult.exitCode == 7 && !basicResult.uncertain && basicResult.stopReason == nil)
    precondition(
      String(decoding: basicBytes.stdout, as: UTF8.self)
        == "\(literal)\n\(directory)\nexplicit\nunset\n")
    precondition(String(decoding: basicBytes.stderr, as: UTF8.self) == "error")
    precondition(!FileManager.default.fileExists(atPath: directory + "/should-not-exist"))

    let descriptor = open("/dev/null", O_RDONLY)
    precondition(descriptor >= 0)
    let inherited = fcntl(descriptor, F_DUPFD, 100)
    close(descriptor)
    precondition(inherited >= 100)
    defer { close(inherited) }
    let isolated = try CommandExecution(command: command("test ! -e /dev/fd/\(inherited)"))
    let isolatedOutput = capture(isolated)
    let isolatedResult = try await isolated.result()
    _ = await isolatedOutput.value
    precondition(isolatedResult.exitCode == 0 && !isolatedResult.uncertain)

    let missing = try CommandExecution(
      command: Command(
        executable: directory + "/missing", arguments: [], directory: directory,
        environment: [:], deadline: Date().addingTimeInterval(5)))
    do {
      _ = try await missing.result()
      fatalError("Missing executable succeeded")
    } catch CommandError.system(let code) { precondition(code == ENOENT) }

    let survivor = try CommandExecution(command: command("sleep 3; printf survivor"))
    let survivorOutput = capture(survivor)
    let child = directory + "/child.sh"
    try Data(
      "trap 'printf stopped > child-stopped; exit 0' TERM\nprintf ready > ready\nsleep 8 &\nwait\n"
        .utf8
    ).write(to: URL(fileURLWithPath: child))
    let group = try CommandExecution(command: command("/bin/sh \"$1\" & wait", arguments: [child]))
    let groupOutput = capture(group)
    for _ in 0..<100 {
      if FileManager.default.fileExists(atPath: directory + "/ready") { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    precondition(FileManager.default.fileExists(atPath: directory + "/ready"))
    group.cancel()
    let groupResult = try await group.result()
    _ = await groupOutput.value
    precondition(groupResult.stopReason != nil && !groupResult.uncertain)
    precondition(FileManager.default.fileExists(atPath: directory + "/child-stopped"))
    let survivorResult = try await survivor.result()
    let survivorBytes = await survivorOutput.value
    precondition(survivorResult.exitCode == 0 && !survivorResult.uncertain)
    precondition(String(decoding: survivorBytes.stdout, as: UTF8.self) == "survivor")

    let resistant = try CommandExecution(
      command: command("trap '' TERM; printf ready; sleep 8", timeout: 0.2))
    let resistantOutput = capture(resistant)
    let resistantResult = try await resistant.result()
    _ = await resistantOutput.value
    precondition(resistantResult.signal == SIGKILL && !resistantResult.uncertain)
    guard case .deadline = resistantResult.stopReason else {
      fatalError("Deadline was not recorded")
    }

    let noisy = try CommandExecution(command: command("/usr/bin/yes fixture"), outputLimit: 8192)
    let noisyOutput = capture(noisy)
    let noisyResult = try await noisy.result()
    let noisyBytes = await noisyOutput.value
    precondition(noisyBytes.stdout.count <= 8192 && !noisyResult.uncertain)
    guard case .outputLimit = noisyResult.stopReason else {
      fatalError("Output cap was not enforced")
    }

    let unread = try CommandExecution(command: command("/usr/bin/yes fixture"))
    let unreadResult = try await unread.result()
    guard case .outputLimit = unreadResult.stopReason else {
      fatalError("Slow consumer was not bounded")
    }
    precondition(!unreadResult.uncertain)

    let canceledTask = try CommandExecution(command: command("sleep 8"))
    let canceledOutput = capture(canceledTask)
    let waiting = Task { try await canceledTask.result() }
    try await Task.sleep(for: .milliseconds(100))
    waiting.cancel()
    let canceledResult = try await waiting.value
    _ = await canceledOutput.value
    guard case .canceled = canceledResult.stopReason else {
      fatalError("Task cancellation was not forwarded")
    }
    precondition(!canceledResult.uncertain)

    let expired = try CommandExecution(command: command("touch expired-must-not-run", timeout: -1))
    let expiredResult = try await expired.result()
    precondition(expiredResult.exitCode == nil && !expiredResult.uncertain)
    precondition(!FileManager.default.fileExists(atPath: directory + "/expired-must-not-run"))
    print("Native command execution checks passed")
  }
}
