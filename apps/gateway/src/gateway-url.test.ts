import { afterAll, describe, expect, test } from "bun:test";
import { users, vms } from "@winston/db/schema";
import { insertUser, testDb } from "@winston/db/testing";
import { createVm, issueRegistrationToken } from "@winston/db/vms";
import { applyVmEvent } from "@winston/db/vm-state";
import { createLogger } from "@winston/shared/logger";
import { eq, inArray } from "drizzle-orm";
import { createGateway, type GatewaySocketData } from "./gateway.ts";

// Committed rows, as in gateway.test.ts (the server uses its own connections).
const db = await testDb();
const gateway = createGateway({
  db,
  logger: createLogger("gateway-test", {
    pretty: false,
    destination: { write: () => undefined },
  }),
  internalSecret: "internal-secret-0123456789abcdefghijklmnop",
  runTokenSecret: "gateway-test-run-token-secret-0123456789",
  selfUrl: "http://10.0.1.7:3001",
});
const server = Bun.serve<GatewaySocketData>({
  port: 0,
  fetch: gateway.fetch,
  websocket: gateway.websocket,
});
const created: string[] = [];
afterAll(async () => {
  await server.stop(true);
  if (created.length > 0)
    await db.delete(users).where(inArray(users.id, created));
});

const gatewayUrlOf = async (vmId: string) =>
  (
    await db.select({ url: vms.gatewayUrl }).from(vms).where(eq(vms.id, vmId))
  )[0]?.url;

describe("which gateway holds a VM", () => {
  test("a gateway records itself on the VMs it holds, and clears it when the VM goes", async () => {
    const user = await insertUser(db);
    created.push(user.id);
    const vm = await createVm(db, user.id, "docker");
    await applyVmEvent(db, vm.id, "provision");
    const token = await issueRegistrationToken(db, vm.id);
    await applyVmEvent(db, vm.id, "provisioned");
    const ws = new WebSocket(
      `ws://localhost:${String(server.port)}/vm/connect`,
      {
        headers: { Authorization: `Bearer ${token}` },
      } as unknown as string[],
    );
    await new Promise((resolve) => {
      ws.addEventListener("open", resolve);
    });
    for (let i = 0; i < 100 && (await gatewayUrlOf(vm.id)) === null; i += 1)
      await Bun.sleep(10);
    expect(await gatewayUrlOf(vm.id)).toBe("http://10.0.1.7:3001");
    ws.close();
    for (let i = 0; i < 100 && (await gatewayUrlOf(vm.id)) !== null; i += 1)
      await Bun.sleep(10);
    expect(await gatewayUrlOf(vm.id)).toBeNull();
  });
});
