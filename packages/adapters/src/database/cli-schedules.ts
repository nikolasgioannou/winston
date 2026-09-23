import { sql } from "drizzle-orm";
import {
  cliScheduleRequestSchema,
  isScheduleMutation,
  type CliResult,
  type CliScheduleRequest,
} from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { DatabaseTransaction } from "./owners";
import { ownerRepository } from "./owners";
import { capabilityRepository } from "./capabilities";
import { taskRepository } from "./tasks";
import { scheduleRepository } from "./schedules";

export async function executeScheduleCommand(
  transaction: DatabaseTransaction,
  ownerId: string,
  credential: ServiceRequest,
  input: CliScheduleRequest,
): Promise<CliResult> {
  const request = cliScheduleRequestSchema.parse(input);
  await transaction.execute(
    sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
  );
  const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
  const operation = isScheduleMutation(request.command) ? "gateway:control" : "gateway:read";
  if (!authority || authority.operation !== operation)
    return { version: 1, status: "denied", message: "Task authority is unavailable or expired." };
  const schedules = scheduleRepository(transaction, ownerId);
  if (request.command === "schedules.list") {
    const records = await schedules.list(request.after);
    return {
      version: 1,
      status: "ok",
      data: {
        schedules: records,
        next: records.length === 100 ? (records.at(-1)?.id ?? null) : null,
      },
    };
  }
  if (request.command === "schedules.inspect") {
    const schedule = await schedules.find(request.id);
    return schedule
      ? { version: 1, status: "ok", data: schedule }
      : { version: 1, status: "unavailable", message: "Schedule unavailable." };
  }
  if (request.command === "schedules.cancel")
    return { version: 1, status: "ok", data: await schedules.cancel(request.id, request.revision) };
  const context = await taskRepository(transaction, ownerId).context({
    id: authority.taskId,
    revision: authority.revision,
    generation: authority.generation,
  });
  // Edits retain the existing timezone unless a replacement was explicitly supplied.
  const previous =
    request.command === "schedules.update"
      ? await schedules.find(request.id)
      : await schedules.findByKey(`cli:${authority.taskId}:${request.key}`);
  const timezone =
    request.timezone ??
    previous?.timing.timezone ??
    (await ownerRepository(transaction, ownerId).timezone()).timezone;
  const change = {
    objective: request.objective,
    sourceMessageIds: context.task.sourceMessageIds,
    timing: request.rule
      ? { kind: "recurring" as const, startAt: request.startAt, timezone, rule: request.rule }
      : { kind: "once" as const, startAt: request.startAt, timezone },
  };
  const schedule =
    request.command === "schedules.create"
      ? await schedules.create({ ...change, key: `cli:${authority.taskId}:${request.key}` })
      : await schedules.update(request.id, request.revision, change);
  return { version: 1, status: "ok", data: schedule };
}
