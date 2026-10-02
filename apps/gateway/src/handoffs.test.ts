import { afterAll, describe, expect, test } from "bun:test";
import { createHandoff } from "@winston/db/handoffs";
import { handoffs, users } from "@winston/db/schema";
import { insertRun, insertUser, testDb } from "@winston/db/testing";
import { createVm, issueRegistrationToken } from "@winston/db/vms";
import { applyVmEvent } from "@winston/db/vm-state";
import {
  parseScreencastMessage,
  screencastMessage,
  type GatewayToVmFrame,
} from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { eq, inArray, sql } from "drizzle-orm";
import { createGateway, type GatewaySocketData } from "./gateway.ts";

// Like gateway.test.ts: the server works on its own connections, so rows are
// committed and the users deleted afterwards.
const db = await testDb();
const logger = createLogger("gateway-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const internalSecret = "internal-secret-0123456789abcdefghijklmnop";
const gateway = createGateway({
  db,
  logger,
  internalSecret,
  runTokenSecret: "gateway-test-run-token-secret-0123456789",
});
const server = Bun.serve<GatewaySocketData>({
  port: 0,
  fetch: gateway.fetch,
  websocket: gateway.websocket,
});
const base = `localhost:${String(server.port)}`;
const createdUsers: string[] = [];

afterAll(async () => {
  await server.stop(true);
  if (createdUsers.length > 0)
    await db.delete(users).where(inArray(users.id, createdUsers));
});

/** A connected fake VM, collecting what the gateway sends it. */
async function connectedVm() {
  const user = await insertUser(db);
  createdUsers.push(user.id);
  const vm = await createVm(db, user.id, "docker");
  await applyVmEvent(db, vm.id, "provision");
  const registration = await issueRegistrationToken(db, vm.id);
  await applyVmEvent(db, vm.id, "provisioned");
  const frames: GatewayToVmFrame[] = [];
  const ws = new WebSocket(`ws://${base}/vm/connect`, {
    headers: { Authorization: `Bearer ${registration}` },
  } as unknown as string[]);
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as GatewayToVmFrame);
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve);
  });
  await eventually(() => frames.some((f) => f.type === "registered"));
  return {
    userId: user.id,
    ws,
    frames,
    next: async (type: GatewayToVmFrame["type"], after = 0) => {
      await eventually(() => frames.slice(after).some((f) => f.type === type));
      const found = frames.slice(after).find((f) => f.type === type);
      if (!found) throw new Error(`no ${type} frame`);
      return found;
    },
  };
}

/** A live-view page: signs in with its first message. */
async function page(auth: Record<string, unknown>) {
  const ws = new WebSocket(`ws://${base}/handoff/connect`);
  ws.binaryType = "arraybuffer";
  const texts: Record<string, unknown>[] = [];
  const binaries: Uint8Array[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string")
      texts.push(JSON.parse(event.data) as Record<string, unknown>);
    else binaries.push(new Uint8Array(event.data as ArrayBuffer));
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve);
  });
  ws.send(JSON.stringify({ type: "auth", ...auth }));
  return { ws, texts, binaries, closed };
}

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition never became true");
}

const internal = (path: string, body: unknown) =>
  fetch(`http://${base}/internal${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("handoff live views", () => {
  test("a page relays one tab's frames and input; the link works once; a reconnect uses the page's secret", async () => {
    const vm = await connectedVm();
    const run = await insertRun(db, vm.userId, { kind: "background" });
    const { id, token } = await createHandoff(db, {
      runId: run.id,
      userId: vm.userId,
      windowId: "win_1",
      targetId: "TARGET1",
      reason: "Sign in",
    });

    const viewer = await page({ token });
    const start = await vm.next("screencast.start");
    expect(start).toMatchObject({ handoffId: id, targetId: "TARGET1" });
    await eventually(() => viewer.texts.length > 0);
    const session = viewer.texts[0] as {
      type: string;
      handoff: string;
      secret: string;
    };
    expect(session).toMatchObject({ type: "session", handoff: id });

    // A frame from the VM reaches the page as it is.
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    vm.ws.send(
      screencastMessage({ handoffId: id, width: 390, height: 844 }, jpeg),
    );
    await eventually(() => viewer.binaries.length > 0);
    const relayed = parseScreencastMessage(
      viewer.binaries[0] ?? new Uint8Array(),
    );
    expect(relayed?.header).toEqual({ handoffId: id, width: 390, height: 844 });
    expect([...(relayed?.jpeg ?? [])]).toEqual([...jpeg]);
    // A frame naming another handoff goes nowhere.
    vm.ws.send(
      screencastMessage({ handoffId: "hnd_other", width: 1, height: 1 }, jpeg),
    );

    // The person's input goes to the VM; anything malformed is dropped.
    const before = vm.frames.length;
    viewer.ws.send("not json");
    viewer.ws.send(
      JSON.stringify({ kind: "pointer", action: "down", x: 10, y: 20 }),
    );
    const input = await vm.next("input", before);
    expect(input).toMatchObject({
      handoffId: id,
      input: { kind: "pointer", action: "down", x: 10, y: 20 },
    });
    expect(viewer.binaries).toHaveLength(1);

    // The link is used up; the page's secret brings it back, replacing the old socket.
    const again = await page({ token });
    expect((await again.closed).code).toBe(4003);
    const startsBefore = vm.frames.filter(
      (f) => f.type === "screencast.start",
    ).length;
    const back = await page({
      handoff: session.handoff,
      secret: session.secret,
    });
    expect((await viewer.closed).code).toBe(4002);
    await eventually(
      () =>
        vm.frames.filter((f) => f.type === "screencast.start").length >
        startsBefore,
    );

    // Releasing the run's windows (the task carried on) ends the live view.
    const released = await internal(`/vms/${vm.userId}/browser/release`, {
      owner: run.id,
    });
    expect(released.status).toBe(200);
    expect((await back.closed).code).toBe(4000);
    await vm.next("browser.release");
    vm.ws.close();
  });

  test("hold asks the VM for the run's window and answers with what it says", async () => {
    const vm = await connectedVm();
    const before = vm.frames.length;
    const held = internal(`/vms/${vm.userId}/browser/hold`, { owner: "run_x" });
    const asked = await vm.next("browser.hold", before);
    expect(asked).toMatchObject({ owner: "run_x" });
    vm.ws.send(
      JSON.stringify({
        id: "r1",
        type: "browser.held",
        replyTo: asked.id,
        window: { windowId: "win_9", targetId: "T9", url: "https://shop.test" },
      }),
    );
    expect(await (await held).json()).toEqual({
      window: { windowId: "win_9", targetId: "T9", url: "https://shop.test" },
    });
    vm.ws.close();
  });

  test("an expired link says so; a page that never signs in is dropped", async () => {
    const vm = await connectedVm();
    const run = await insertRun(db, vm.userId, { kind: "background" });
    const { id, token } = await createHandoff(db, {
      runId: run.id,
      userId: vm.userId,
      windowId: "win_1",
      targetId: "T1",
      reason: "x",
    });
    await db
      .update(handoffs)
      .set({ connectDeadline: sql`now() - interval '1 second'` })
      .where(eq(handoffs.id, id));
    const late = await page({ token });
    expect(await late.closed).toEqual({
      code: 4004,
      reason: "This link expired. Ask Winston for a new one.",
    });
    const nonsense = await page({ nope: true });
    expect((await nonsense.closed).code).toBe(4003);
    vm.ws.close();
  });
});
