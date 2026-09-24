import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { actionRecordSchema } from "@winston/contracts/actions";
import { deviceExecutionSchema, type DeviceExecution } from "@winston/contracts/device-executions";
import { deviceMessageSchema, type DeviceMessage } from "@winston/contracts/devices";
import {
  deviceSessionIdentitySchema,
  type DeviceSessionIdentity,
} from "@winston/contracts/device-registry";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { eventRepository } from "./events";

type Proof = Parameters<ReturnType<typeof actionRepository>["authorizeDevice"]>[0];
type Reservation =
  { status: "reserved" | "existing"; execution: DeviceExecution } | { status: "denied" | "busy" };

const terminal = (state: DeviceExecution["state"]) =>
  ["succeeded", "failed", "canceled"].includes(state);

export function deviceExecutionRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }

  async function find(inputId: string) {
    const id = actionRecordSchema.shape.operationId.parse(inputId);
    const rows = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.device_executions
      WHERE owner_id = ${ownerId}::uuid AND execution_id = ${id}::uuid
    `);
    return rows.rows[0] ? deviceExecutionSchema.parse(rows.rows[0].document) : null;
  }

  async function live(session: DeviceSessionIdentity) {
    const rows = await transaction.execute(sql`
      SELECT 1 FROM winston.device_sessions s
      JOIN winston.devices d ON d.owner_id = s.owner_id AND d.id = s.device_id
      WHERE s.owner_id = ${ownerId}::uuid AND s.device_id = ${session.deviceId}::uuid
        AND s.session_id = ${session.sessionId}::uuid AND s.generation = ${session.generation}
        AND s.disconnected_at IS NULL AND s.lease_until > clock_timestamp()
        AND d.revoked_at IS NULL AND d.token_hash = s.credential_hash
    `);
    return rows.rows.length === 1;
  }

  async function save(execution: DeviceExecution, publish = true) {
    const next = deviceExecutionSchema.parse(execution);
    if (next.message.payload.kind !== "execute") throw new Error("Invalid execution record.");
    const id = next.message.payload.executionId;
    await transaction.execute(sql`
      UPDATE winston.device_executions SET state = ${next.state}, document = ${JSON.stringify(next)}::jsonb
      WHERE owner_id = ${ownerId}::uuid AND execution_id = ${id}::uuid
    `);
    const evidence =
      next.reconciliation?.response?.messageId ?? next.receipt?.messageId ?? "reserved";
    if (publish)
      await eventRepository(transaction, ownerId).publish({
        key: `${id}:${next.state}:${evidence}`,
        type: "device.execution-changed",
        payload: { executionId: id, deviceId: next.message.deviceId, state: next.state },
        destinations: ["device-runtime"],
      });
    return next;
  }

  return {
    find,
    async reserve(input: Proof): Promise<Reservation> {
      const message = deviceMessageSchema.parse(input.message);
      const payload = message.payload;
      if (payload.kind !== "execute") return { status: "denied" };
      await lock();
      if (!(await actionRepository(transaction, ownerId).authorizeDevice({ ...input, message })))
        return { status: "denied" };
      const previous = await find(payload.executionId);
      if (previous) {
        if (
          previous.actionId !== input.id ||
          canonicalJson(previous.task) !== canonicalJson(input.task) ||
          canonicalJson(previous.message) !== canonicalJson(message)
        )
          throw new Error("Execution identity conflicts with its reservation.");
        return { status: "existing", execution: previous };
      }

      // Commands can invoke desktop automation, so they share the desktop resource.
      const resource = ["file.read", "file.write"].includes(payload.operation.kind)
        ? "file"
        : "desktop";
      const occupied = await transaction.execute<{ slot: number }>(sql`
        SELECT slot FROM winston.device_executions
        WHERE owner_id = ${ownerId}::uuid AND device_id = ${message.deviceId}::uuid
          AND resource = ${resource} AND state IN ('dispatching', 'accepted', 'running', 'unknown')
      `);
      const slots = resource === "desktop" ? [0] : [0, 1];
      const slot = slots.find((candidate) => !occupied.rows.some((row) => row.slot === candidate));
      if (slot === undefined) return { status: "busy" };
      const execution = deviceExecutionSchema.parse({
        actionId: input.id,
        task: input.task,
        message,
        state: "dispatching",
        receipt: null,
      });
      await transaction.execute(sql`
        INSERT INTO winston.device_executions
          (owner_id, device_id, execution_id, action_id, session_id, generation, resource, slot, state, deadline, document)
        VALUES (${ownerId}::uuid, ${message.deviceId}::uuid, ${payload.executionId}::uuid, ${input.id}::uuid,
          ${message.sessionId}::uuid, ${message.generation}, ${resource}, ${slot}, 'dispatching',
          to_timestamp(${payload.deadline}::numeric / 1000), ${JSON.stringify(execution)}::jsonb)
      `);
      // Only this branch, after transaction commit, permits the one initial send.
      return { status: "reserved", execution: await save(execution) };
    },

    async receipt(input: DeviceMessage) {
      const message = deviceMessageSchema.parse(input);
      const payload = message.payload;
      if (payload.kind !== "status") return null;
      if (["accepted", "running", "canceled"].includes(payload.state) && payload.exitCode !== null)
        return null;
      if (payload.state === "succeeded" && payload.exitCode !== null && payload.exitCode !== 0)
        return null;
      await lock();
      const current = await find(payload.executionId);
      if (!current || current.message.payload.kind !== "execute") return null;
      const original = current.message;
      const binding = current.message.payload;
      if (
        original.deviceId !== message.deviceId ||
        original.sessionId !== message.sessionId ||
        original.generation !== message.generation ||
        original.messageId !== message.correlationId ||
        binding.taskId !== payload.taskId ||
        binding.taskRevision !== payload.taskRevision
      )
        return null;
      // Facts may arrive after task cancellation or local pause. They still need
      // the authenticated original live session; reconnect reconciliation is separate.
      if (!(await live(message))) return null;
      const prior = current.receipt?.payload;
      if (prior?.kind === "status") {
        if (canonicalJson(prior) === canonicalJson(payload)) return current;
        if (payload.sequence <= prior.sequence) return null;
      }
      if (terminal(current.state)) return null;
      if (current.state === "running" && payload.state === "accepted") return null;
      const state =
        current.state === "unknown" && !terminal(payload.state) ? "unknown" : payload.state;
      return save({ ...current, state, receipt: message });
    },

    async requestReconciliation(inputId: string, inputSession: DeviceSessionIdentity) {
      const session = deviceSessionIdentitySchema.parse(inputSession);
      await lock();
      const current = await find(inputId);
      if (!current || terminal(current.state) || current.message.payload.kind !== "execute")
        return null;
      if (current.message.deviceId !== session.deviceId || !(await live(session))) return null;
      const original = current.message.payload;
      const request = deviceMessageSchema.parse({
        version: 1,
        messageId: randomUUID(),
        correlationId: current.message.messageId,
        ...session,
        payload: {
          kind: "reconcile",
          executionId: original.executionId,
          taskId: original.taskId,
          taskRevision: original.taskRevision,
          operation: original.operation,
        },
      });
      // Commit this query before sending. A newer query fences all older replies.
      await save(
        { ...current, state: "unknown", reconciliation: { request, response: null } },
        current.state !== "unknown",
      );
      return request;
    },

    async reconcile(input: DeviceMessage) {
      const message = deviceMessageSchema.parse(input);
      const result = message.payload;
      if (result.kind !== "reconciled") return null;
      await lock();
      const current = await find(result.executionId);
      const query = current?.reconciliation?.request;
      if (!current || !query || query.payload.kind !== "reconcile") return null;
      if (
        message.correlationId !== query.messageId ||
        message.deviceId !== query.deviceId ||
        message.sessionId !== query.sessionId ||
        message.generation !== query.generation ||
        result.taskId !== query.payload.taskId ||
        result.taskRevision !== query.payload.taskRevision ||
        !(await live(message))
      )
        return null;
      const previous = current.reconciliation?.response;
      if (previous)
        return canonicalJson(previous.payload) === canonicalJson(result) ? current : null;
      if (terminal(current.state)) return null;
      // Missing storage is not proof that an effect never happened. Every nonterminal
      // answer, including still-running work, retains the reservation as unknown.
      const state =
        result.state === "succeeded" || result.state === "failed" || result.state === "canceled"
          ? result.state
          : "unknown";
      return save({ ...current, state, reconciliation: { request: query, response: message } });
    },

    async expire() {
      await lock();
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT e.document FROM winston.device_executions e
        LEFT JOIN winston.device_sessions s ON s.owner_id = e.owner_id AND s.device_id = e.device_id
        JOIN winston.devices d ON d.owner_id = e.owner_id AND d.id = e.device_id
        WHERE e.owner_id = ${ownerId}::uuid AND e.state IN ('dispatching', 'accepted', 'running')
          AND (e.deadline <= clock_timestamp() OR s.session_id IS DISTINCT FROM e.session_id
            OR s.generation IS DISTINCT FROM e.generation OR s.disconnected_at IS NOT NULL
            OR s.lease_until <= clock_timestamp() OR d.revoked_at IS NOT NULL
            OR d.token_hash IS DISTINCT FROM s.credential_hash)
        ORDER BY e.deadline, e.execution_id LIMIT 100
      `);
      for (const row of rows.rows)
        await save({ ...deviceExecutionSchema.parse(row.document), state: "unknown" });
      // Unknown executions retain their unique resource slot until proven terminal.
      return rows.rows.length;
    },
  };
}
