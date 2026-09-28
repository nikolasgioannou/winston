import {
  newFrameId,
  type ExecResult,
  type GatewayToVmFrame,
  type VmToGatewayFrame,
} from "@winston/domain/frames";

/** How long past its own timeout a command may take to report back (e.g. across a reconnect). */
export const execGraceMs = 60_000;

export class VmUnavailableError extends Error {
  constructor() {
    super("Winston's computer isn't connected right now.");
  }
}

export class VmUnreachableError extends Error {
  constructor() {
    super("Winston's computer stopped responding before the command finished.");
  }
}

interface Pending {
  vmId: string;
  stdout: string[];
  stderr: string[];
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Commands in flight on VMs (docs/design.md §15). Sends `exec`, collects the
 * streamed output until `exec.exit`, and if the VM reconnects mid-command,
 * asks for the buffered result (`exec.fetch`) instead of running it again.
 */
export function createExecs(
  send: (vmId: string, frame: GatewayToVmFrame) => boolean,
) {
  const pending = new Map<string, Pending>();

  const settle = (execId: string, outcome: ExecResult | Error) => {
    const exec = pending.get(execId);
    if (!exec) return;
    pending.delete(execId);
    clearTimeout(exec.timer);
    if (outcome instanceof Error) exec.reject(outcome);
    else exec.resolve(outcome);
  };

  return {
    /** Runs a command on a connected VM. Throws `VmUnavailableError` if it isn't connected. */
    run(
      vmId: string,
      request: {
        cmd: string;
        cwd?: string | undefined;
        env: Record<string, string>;
        timeoutMs: number;
      },
    ) {
      const id = newFrameId();
      return new Promise<ExecResult>((resolve, reject) => {
        const frame: GatewayToVmFrame = {
          id,
          type: "exec",
          cmd: request.cmd,
          env: request.env,
          timeoutMs: request.timeoutMs,
          ...(request.cwd ? { cwd: request.cwd } : {}),
        };
        if (!send(vmId, frame)) {
          reject(new VmUnavailableError());
          return;
        }
        pending.set(id, {
          vmId,
          stdout: [],
          stderr: [],
          resolve,
          reject,
          timer: setTimeout(() => {
            settle(id, new VmUnreachableError());
          }, request.timeoutMs + execGraceMs),
        });
      });
    },

    /** Feeds a frame from a VM. Returns true if it was about a command. */
    handle(vmId: string, frame: VmToGatewayFrame) {
      if (
        frame.type !== "exec.output" &&
        frame.type !== "exec.exit" &&
        frame.type !== "exec.result"
      )
        return false;
      const exec = pending.get(frame.execId);
      // Unknown, or from another VM: ignore it.
      if (exec?.vmId !== vmId) return true;
      if (frame.type === "exec.output") exec[frame.stream].push(frame.data);
      else if (frame.type === "exec.exit")
        settle(frame.execId, {
          stdout: exec.stdout.join(""),
          stderr: exec.stderr.join(""),
          exitCode: frame.exitCode,
          timedOut: frame.timedOut,
          truncated: frame.truncated,
        });
      else if (frame.found) {
        const { stdout, stderr, exitCode, timedOut, truncated } = frame;
        settle(frame.execId, { stdout, stderr, exitCode, timedOut, truncated });
      } else settle(frame.execId, new VmUnreachableError());
      return true;
    },

    /** A VM (re)connected: ask it for the results of commands it was running. */
    reconnected(vmId: string) {
      for (const [execId, exec] of pending)
        if (exec.vmId === vmId)
          send(vmId, { id: newFrameId(), type: "exec.fetch", execId });
    },

    get size() {
      return pending.size;
    },
  };
}

export type Execs = ReturnType<typeof createExecs>;
