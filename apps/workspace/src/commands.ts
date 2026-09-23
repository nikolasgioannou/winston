import { createHash } from "node:crypto";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { commandResultSchema, type CommandOutputChannel } from "@winston/contracts/commands";
import type { WorkspaceOperation } from "@winston/contracts/workspace";
import { canonicalJson } from "@winston/contracts/json";
import {
  workspaceCommandSchema,
  type WorkspaceCommand,
} from "@winston/contracts/workspace-commands";
import type { createWorkspaceAuthority } from "./authority";
import type { openWorkspaceJournal } from "./journal";
import type { createCommandRunner } from "./processes";

export class CommandError extends Error {
  constructor(readonly code: "forbidden" | "authority_unavailable" | "operation_unavailable") {
    super(code);
  }
}

type Runner = ReturnType<typeof createCommandRunner>;
type Handle = ReturnType<Runner["start"]>;
type Active = {
  command: WorkspaceCommand;
  credential: ServiceRequest;
  handle: Handle;
  lease: () => void;
  check: () => void;
  revision: number;
  stopping: boolean;
  done: Promise<void>;
};

function after(milliseconds: number, callback: () => void) {
  const timer = setTimeout(callback, milliseconds);
  return () => {
    clearTimeout(timer);
  };
}

export function createCommandService(options: {
  journal: ReturnType<typeof openWorkspaceJournal>;
  runner: Runner;
  authority: Pick<ReturnType<typeof createWorkspaceAuthority>, "command" | "control" | "gateway">;
  after?: typeof after;
}) {
  const schedule = options.after ?? after;
  const active = new Map<string, Active>();
  let closing = false;

  async function authorize(check: () => Promise<boolean>) {
    let allowed;
    try {
      allowed = await check();
    } catch {
      throw new CommandError("authority_unavailable");
    }
    if (!allowed) throw new CommandError("forbidden");
  }

  async function validate(credential: ServiceRequest, input: WorkspaceCommand) {
    const command = workspaceCommandSchema.parse(input);
    if (
      createHash("sha256").update(canonicalJson(command.input)).digest("hex") !==
      command.operation.inputHash
    )
      throw new CommandError("forbidden");
    await authorize(() => options.authority.command(credential, command));
    if (closing) throw new CommandError("operation_unavailable");
    return command;
  }

  function stop(entry: Active) {
    if (entry.stopping) return;
    entry.stopping = true;
    entry.lease();
    entry.check();
    entry.handle.cancel();
  }

  function watch(entry: Active) {
    entry.check = schedule(5000, () => {
      const revision = entry.revision;
      options.authority
        .command(entry.credential, entry.command)
        .catch(() => false)
        .then((allowed) => {
          if (entry.stopping) return;
          // A late response about an old token cannot invalidate a newly authorized renewal.
          if (!allowed && revision === entry.revision) stop(entry);
          else watch(entry);
        })
        .catch(() => {
          stop(entry);
        });
    });
  }

  function renew(entry: Active, credential: ServiceRequest) {
    entry.lease();
    entry.credential = credential;
    entry.revision += 1;
    entry.lease = schedule(30_000, () => {
      stop(entry);
    });
  }

  return {
    async start(credential: ServiceRequest, input: WorkspaceCommand) {
      const command = await validate(credential, input);
      const operation = command.operation;
      const claim = options.journal.start(operation);
      if (!claim.started) return claim.record;
      let handle: Handle;
      try {
        const authority = await options.authority.gateway(credential, command);
        if (closing) throw new CommandError("operation_unavailable");
        handle = options.runner.start(operation.operationId, command.input, authority);
      } catch {
        options.journal.finish(operation, claim.completionToken, {
          state: "failed",
          code: "command_unavailable",
        });
        return options.journal.read(operation);
      }
      const entry: Active = {
        command,
        credential,
        handle,
        lease: () => {},
        check: () => {},
        revision: 0,
        stopping: false,
        done: Promise.resolve(),
      };
      active.set(operation.operationId, entry);
      renew(entry, credential);
      watch(entry);
      entry.done = handle.result
        .then((result) => {
          if (result.reason === "unknown")
            options.journal.uncertain(operation, claim.completionToken);
          else
            options.journal.finish(operation, claim.completionToken, {
              state: "completed",
              result: JSON.stringify(result),
            });
        })
        .catch(() => {
          try {
            options.journal.uncertain(operation, claim.completionToken);
          } catch {
            /* Storage loss leaves the durable running record for startup recovery. */
          }
        })
        .finally(() => {
          entry.stopping = true;
          entry.lease();
          entry.check();
          active.delete(operation.operationId);
        });
      return options.journal.read(operation);
    },
    async renew(credential: ServiceRequest, input: WorkspaceCommand) {
      const command = await validate(credential, input);
      const record = options.journal.read(command.operation);
      const entry = active.get(command.operation.operationId);
      if (entry && !entry.stopping) renew(entry, credential);
      return record;
    },
    async control(credential: ServiceRequest, operation: WorkspaceOperation) {
      await authorize(() => options.authority.control(credential, operation));
      const record = options.journal.read(operation);
      if (credential.operation === "workspace:cancel") {
        const entry = active.get(operation.operationId);
        if (entry) stop(entry);
      }
      return record;
    },
    async output(
      credential: ServiceRequest,
      operation: WorkspaceOperation,
      channel: CommandOutputChannel,
    ) {
      if (credential.operation !== "workspace:observe") throw new CommandError("forbidden");
      await authorize(() => options.authority.control(credential, operation));
      const record = options.journal.read(operation);
      if (record?.outcome?.state !== "completed") return null;
      const result = commandResultSchema.parse(JSON.parse(record.outcome.result));
      const output = result[channel];
      return {
        output,
        stream: options.runner.output(operation.operationId, channel, output.bytes),
      };
    },
    async close() {
      closing = true;
      const pending = [...active.values()];
      for (const entry of pending) stop(entry);
      await options.runner.close();
      await Promise.all(pending.map((entry) => entry.done));
    },
  };
}
