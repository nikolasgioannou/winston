import { setTimeout as sleep } from "node:timers/promises";
import {
  cliDeviceResultSchema,
  deviceCommandTimeoutMs,
  type CliAuthority,
  type CliDeviceRequest,
  type CliRequest,
  type CliResult,
} from "@winston/contracts/cli";
import { callGateway } from "./gateway";

export async function callDeviceCommand(
  authority: CliAuthority,
  request: Exclude<CliDeviceRequest, { command: "devices.result" }>,
  options: {
    call?: (authority: CliAuthority, request: CliRequest) => Promise<CliResult>;
    wait?: () => Promise<void>;
    now?: () => number;
  } = {},
): Promise<CliResult> {
  const call = options.call ?? callGateway;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => sleep(1000));
  const deadline = Math.min(
    now() + deviceCommandTimeoutMs + 15_000,
    Date.parse(authority.expiresAt),
  );
  let result = await call(authority, request);
  if (result.status !== "ok") return result;
  let receipt = cliDeviceResultSchema.parse(result.data);
  const id = receipt.id;
  const executionId = receipt.executionId;
  const unknown = (): CliResult => ({
    version: 1,
    status: "unknown",
    referenceId: id,
    message: "The operation outcome is not confirmed. Inspect this operation before retrying.",
  });
  try {
    for (;;) {
      if (
        receipt.id !== id ||
        receipt.executionId !== executionId ||
        receipt.deviceId !== request.id
      )
        return unknown();
      if (request.command === "devices.read" && receipt.state === "succeeded" && !receipt.artifact)
        return unknown();
      if (["succeeded", "failed", "canceled"].includes(receipt.state)) return result;
      if (receipt.state === "unknown" || now() >= deadline) return unknown();
      await wait();
      if (now() >= deadline) return unknown();
      // Keep the original workspace worker alive. Poll evidence, never execute again.
      result = await call(authority, { version: 1, command: "devices.result", id, after: -1 });
      if (result.status !== "ok") return unknown();
      receipt = cliDeviceResultSchema.parse(result.data);
    }
  } catch {
    return unknown();
  }
}
