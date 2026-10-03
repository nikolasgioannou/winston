import { afterAll, describe, expect, test } from "bun:test";
import { createHandoff } from "@winston/db/handoffs";
import { runMessages, runs, users } from "@winston/db/schema";
import { insertRun, insertUser, testDb } from "@winston/db/testing";
import { createVm, issueRegistrationToken } from "@winston/db/vms";
import { applyVmEvent } from "@winston/db/vm-state";
import { issueViewerTicket } from "@winston/db/viewer-tickets";
import {
  parseScreencastMessage,
  screencastMessage,
  type GatewayToVmFrame,
  type ListedWindow,
} from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { eq, inArray } from "drizzle-orm";
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
  const binaries: Uint8Array[] = [];
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      binaries.push(new Uint8Array(event.data as ArrayBuffer));
      return;
    }
    frames.push(JSON.parse(event.data) as GatewayToVmFrame);
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve);
  });
  await eventually(() => frames.some((f) => f.type === "registered"));
  return {
    userId: user.id,
    ws,
    frames,
    binaries,
    next: async (type: GatewayToVmFrame["type"], after = 0) => {
      await eventually(() => frames.slice(after).some((f) => f.type === type));
      const found = frames.slice(after).find((f) => f.type === type);
      if (!found) throw new Error(`no ${type} frame`);
      return found;
    },
  };
}

/** A browser page's socket: signs in with a ticket from its own server. */
async function page(userId: string, extra: Record<string, unknown> = {}) {
  const ticket = await issueViewerTicket(db, userId);
  const ws = new WebSocket(`ws://${base}/browser/connect`);
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
  ws.send(JSON.stringify({ type: "auth", ticket, ...extra }));
  const said = async (type: string, after = 0) => {
    await eventually(() => texts.slice(after).some((t) => t.type === type));
    return texts.slice(after).find((t) => t.type === type) ?? {};
  };
  const ask = (message: Record<string, unknown>) => {
    ws.send(JSON.stringify(message));
  };
  return { ws, ticket, texts, binaries, closed, said, ask };
}

/** The VM's side of listings and holds: answers from `windows`, holding what's asked. */
function answerBrowser(
  vm: Awaited<ReturnType<typeof connectedVm>>,
  windows: ListedWindow[],
) {
  let seen = 0;
  const timer = setInterval(() => {
    for (const frame of vm.frames.slice(seen)) {
      if (frame.type === "browser.list")
        vm.ws.send(
          JSON.stringify({
            id: `r-${frame.id}`,
            type: "browser.listed",
            replyTo: frame.id,
            windows,
          }),
        );
      if (frame.type === "browser.hold") {
        const window = windows.find((w) => w.windowId === frame.windowId);
        if (window) window.held = frame.takeover ? "takeover" : "handoff";
        vm.ws.send(
          JSON.stringify({
            id: `r-${frame.id}`,
            type: "browser.held",
            replyTo: frame.id,
            window: window
              ? {
                  windowId: window.windowId,
                  targetId: window.targetId,
                  url: window.url,
                }
              : null,
          }),
        );
      }
      if (frame.type === "browser.release")
        for (const window of windows)
          if (
            window.owner === frame.owner &&
            (!frame.windowId || window.windowId === frame.windowId)
          )
            window.held = null;
    }
    seen = vm.frames.length;
  }, 5);
  return () => {
    clearInterval(timer);
  };
}

const listed = (overrides: Partial<ListedWindow>): ListedWindow => ({
  windowId: "win_1",
  targetId: "T1",
  owner: "front",
  url: "https://shop.test",
  title: "Shop",
  held: null,
  lastUsedAt: Date.now(),
  ...overrides,
});

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

describe("the browser page's live views", () => {
  test("a page signs in with a ticket its server issued, once; anything else is refused", async () => {
    const vm = await connectedVm();
    const first = await page(vm.userId);
    await first.said("ready");
    const again = new WebSocket(`ws://${base}/browser/connect`);
    const closed = new Promise<number>((resolve) => {
      again.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });
    await new Promise((resolve) => {
      again.addEventListener("open", resolve);
    });
    again.send(JSON.stringify({ type: "auth", ticket: first.ticket }));
    expect(await closed).toBe(4003);
    first.ws.close();
    vm.ws.close();
  });

  test("it lists the windows with what each is for, and streams the one it watches, only to it", async () => {
    const vm = await connectedVm();
    const task = await insertRun(db, vm.userId, {
      kind: "background",
      brief: "Book a table at Zuni for Friday",
    });
    await createHandoff(db, {
      runId: task.id,
      userId: vm.userId,
      windowId: "win_2",
      targetId: "T2",
      reason: "Sign in to OpenTable",
    });
    const stop = answerBrowser(vm, [
      listed({}),
      listed({
        windowId: "win_2",
        targetId: "T2",
        owner: task.id,
        held: "handoff",
      }),
    ]);
    const viewer = await page(vm.userId);
    await viewer.said("ready");
    viewer.ask({ type: "windows" });
    const { windows } = (await viewer.said("windows")) as {
      windows: unknown[];
    };
    expect(windows).toEqual([
      expect.objectContaining({
        id: "win_1",
        owner: "front",
        task: null,
        held: null,
        reason: null,
      }),
      expect.objectContaining({
        id: "win_2",
        task: "Book a table at Zuni for Friday",
        held: "handoff",
        reason: "Sign in to OpenTable",
        control: null,
      }),
    ]);
    const before = vm.frames.length;
    viewer.ask({ type: "watch", windowId: "win_1" });
    const start = await vm.next("screencast.start", before);
    expect(start).toMatchObject({ targetId: "T1" });
    const viewId = (start as { viewId: string }).viewId;
    const jpeg = new Uint8Array([0xff, 0xd8, 1]);
    vm.ws.send(screencastMessage({ viewId, width: 390, height: 844 }, jpeg));
    vm.ws.send(
      screencastMessage({ viewId: "view_other", width: 1, height: 1 }, jpeg),
    );
    await eventually(() => viewer.binaries.length > 0);
    await Bun.sleep(30);
    expect(viewer.binaries).toHaveLength(1);
    expect(
      parseScreencastMessage(viewer.binaries[0] ?? new Uint8Array())?.header
        .viewId,
    ).toBe(viewId);
    stop();
    viewer.ws.close();
    vm.ws.close();
  });

  test("a window Winston is driving is watch-only until the page takes it over", async () => {
    const vm = await connectedVm();
    const stop = answerBrowser(vm, [listed({})]);
    const viewer = await page(vm.userId);
    await viewer.said("ready");
    viewer.ask({ type: "watch", windowId: "win_1" });
    expect(await viewer.said("watching")).toMatchObject({ control: false });
    const before = vm.frames.length;
    viewer.ask({ kind: "pointer", action: "down", x: 1, y: 2 });
    await Bun.sleep(50);
    expect(vm.frames.slice(before).some((f) => f.type === "input")).toBe(false);
    viewer.ask({ type: "control" });
    expect(await vm.next("browser.hold", before)).toMatchObject({
      owner: "front",
      windowId: "win_1",
      takeover: true,
    });
    expect(await viewer.said("control")).toMatchObject({
      windowId: "win_1",
      yours: true,
    });
    viewer.ask({ kind: "pointer", action: "down", x: 1, y: 2 });
    expect(await vm.next("input", before)).toMatchObject({
      input: { kind: "pointer", action: "down", x: 1, y: 2 },
    });
    // Done gives a taken-over window back.
    const atDone = vm.frames.length;
    viewer.ask({ type: "done" });
    expect(await vm.next("browser.release", atDone)).toMatchObject({
      owner: "front",
      windowId: "win_1",
    });
    stop();
    viewer.ws.close();
    vm.ws.close();
  });

  test("a handed-over window is the page's to work in; Done carries the task on, and the page keeps watching", async () => {
    const vm = await connectedVm();
    const task = await insertRun(db, vm.userId, {
      kind: "background",
      status: "parked",
    });
    await db.insert(runMessages).values({
      runId: task.id,
      seq: 0,
      role: "assistant",
      content: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "browser_handoff",
            input: { reason: "Sign in" },
          },
        ],
      },
    });
    await createHandoff(db, {
      runId: task.id,
      userId: vm.userId,
      windowId: "win_2",
      targetId: "T2",
      reason: "Sign in",
    });
    const stop = answerBrowser(vm, [
      listed({
        windowId: "win_2",
        targetId: "T2",
        owner: task.id,
        held: "handoff",
      }),
    ]);
    const viewer = await page(vm.userId);
    await viewer.said("ready");
    viewer.ask({ type: "watch", windowId: "win_2" });
    expect(await viewer.said("control")).toMatchObject({ yours: true });
    const before = vm.frames.length;
    const told = viewer.texts.length;
    viewer.ask({ type: "done" });
    expect(await vm.next("browser.release", before)).toMatchObject({
      owner: task.id,
      windowId: "win_2",
    });
    expect(await viewer.said("control", told)).toMatchObject({ yours: false });
    await eventually(async () => {
      const [run] = await db.select().from(runs).where(eq(runs.id, task.id));
      return run?.status !== "parked";
    });
    expect(viewer.ws.readyState).toBe(WebSocket.OPEN);
    stop();
    viewer.ws.close();
    vm.ws.close();
  });

  test("two pages can watch; control is the last one's to take, and Winston taking it back closes nothing", async () => {
    const vm = await connectedVm();
    const stop = answerBrowser(vm, [listed({})]);
    const phone = await page(vm.userId);
    const laptop = await page(vm.userId);
    await phone.said("ready");
    await laptop.said("ready");
    phone.ask({ type: "watch", windowId: "win_1" });
    await phone.said("watching");
    phone.ask({ type: "control" });
    await phone.said("control");
    laptop.ask({ type: "watch", windowId: "win_1" });
    expect(await laptop.said("watching")).toMatchObject({ control: false });
    const told = phone.texts.length;
    laptop.ask({ type: "control" });
    expect(await laptop.said("control")).toMatchObject({ yours: true });
    expect(await phone.said("control", told)).toMatchObject({ yours: false });
    // Winston's side gives it back (the user wrote; a task carried on).
    const released = await internal(`/vms/${vm.userId}/browser/release`, {
      owner: "front",
      windowId: "win_1",
    });
    expect(released.status).toBe(200);
    const laptopTold = laptop.texts.length - 1;
    expect(await laptop.said("control", laptopTold)).toMatchObject({
      yours: false,
    });
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
    expect(laptop.ws.readyState).toBe(WebSocket.OPEN);
    stop();
    phone.ws.close();
    laptop.ws.close();
    vm.ws.close();
  });

  test("the full desktop opens only while the person has a window; a window that goes ends its stream", async () => {
    const vm = await connectedVm();
    const stop = answerBrowser(vm, [listed({})]);
    const early = await page(vm.userId, { desktop: true });
    expect((await early.closed).code).toBe(4003);
    const viewer = await page(vm.userId);
    await viewer.said("ready");
    const before = vm.frames.length;
    viewer.ask({ type: "watch", windowId: "win_1" });
    const start = await vm.next("screencast.start", before);
    viewer.ask({ type: "control" });
    await viewer.said("control");
    const desktop = await page(vm.userId, { desktop: true });
    expect(await vm.next("desktop.open", before)).toMatchObject({});
    vm.ws.send(
      JSON.stringify({
        id: "e1",
        type: "screencast.ended",
        viewId: (start as { viewId: string }).viewId,
        reason: "That window is gone.",
      }),
    );
    expect(await viewer.said("ended")).toMatchObject({ windowId: "win_1" });
    stop();
    desktop.ws.close();
    viewer.ws.close();
    vm.ws.close();
  });

  test("a VM that disconnects closes its pages with 4001, so they sign in again", async () => {
    const vm = await connectedVm();
    const viewer = await page(vm.userId);
    await viewer.said("ready");
    vm.ws.close();
    expect((await viewer.closed).code).toBe(4001);
  });
});
