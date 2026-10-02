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
  /** Everyone waiting on it: the first caller, and any retry with the same id. */
  promise: Promise<ExecResult | undefined>;
  resolve: (result: ExecResult | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Only asking for a result: the VM not knowing the id means "not found". */
  fetchOnly: boolean;
}

/**
 * Commands in flight on VMs (docs/design.md §15). Sends `exec`, collects the
 * streamed output until `exec.exit`. A command cut off by its socket
 * closing fails at once, to be retried by id (the VM never runs an id twice).
 */
export function createExecs(
  send: (vmId: string, frame: GatewayToVmFrame) => boolean,
) {
  const pending = new Map<string, Pending>();

  const settle = (execId: string, outcome: ExecResult | Error | undefined) => {
    const exec = pending.get(execId);
    if (!exec) return;
    pending.delete(execId);
    clearTimeout(exec.timer);
    if (outcome instanceof Error) exec.reject(outcome);
    else exec.resolve(outcome);
  };

  /** Sends `frame` and waits on `execId`, joining anyone already waiting on it. */
  function track(
    vmId: string,
    execId: string,
    frame: GatewayToVmFrame,
    timeoutMs: number,
    fetchOnly: boolean,
  ): Promise<ExecResult | undefined> {
    const existing = pending.get(execId);
    if (existing?.vmId === vmId) return existing.promise;
    if (!send(vmId, frame)) return Promise.reject(new VmUnavailableError());
    let resolve: Pending["resolve"] = () => undefined;
    let reject: Pending["reject"] = () => undefined;
    const promise = new Promise<ExecResult | undefined>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending.set(execId, {
      vmId,
      stdout: [],
      stderr: [],
      promise,
      resolve,
      reject,
      fetchOnly,
      timer: setTimeout(() => {
        settle(execId, new VmUnreachableError());
      }, timeoutMs + execGraceMs),
    });
    return promise;
  }

  return {
    /**
     * Runs a command on a connected VM. Throws `VmUnavailableError` if it
     * isn't connected. A caller-chosen `id` makes it idempotent: the same id
     * again joins the command in flight, and the VM never runs an id twice.
     */
    async run(
      vmId: string,
      request: {
        id?: string | undefined;
        cmd: string;
        cwd?: string | undefined;
        env: Record<string, string>;
        timeoutMs: number;
      },
    ): Promise<ExecResult> {
      const id = request.id ?? newFrameId();
      const frame: GatewayToVmFrame = {
        id,
        type: "exec",
        cmd: request.cmd,
        env: request.env,
        timeoutMs: request.timeoutMs,
        ...(request.cwd ? { cwd: request.cwd } : {}),
      };
      const result = await track(vmId, id, frame, request.timeoutMs, false);
      if (!result) throw new VmUnreachableError();
      return result;
    },

    /**
     * A command's result by id, without running anything: the one in flight,
     * or the VM's buffered copy (kept 5 minutes), or undefined if the VM has
     * no record of it.
     */
    fetch(vmId: string, execId: string, timeoutMs = 10 * 60_000) {
      return track(
        vmId,
        execId,
        { id: newFrameId(), type: "exec.fetch", execId },
        timeoutMs,
        true,
      );
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
      } else
        settle(
          frame.execId,
          exec.fetchOnly ? undefined : new VmUnreachableError(),
        );
      return true;
    },

    /**
     * A VM's socket closed: its commands fail now with `VmUnavailableError`
     * rather than wait. The VM keeps running them, and the caller's retry
     * with the same id (on whichever gateway the VM reconnects to) gets the
     * result, never a second run.
     */
    closed(vmId: string) {
      for (const [execId, exec] of pending)
        if (exec.vmId === vmId) settle(execId, new VmUnavailableError());
    },

    get size() {
      return pending.size;
    },
  };
}

export type Execs = ReturnType<typeof createExecs>;
