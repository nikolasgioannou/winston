import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import {
  parseDesktopMessage,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { createDesktops } from "./desktop.ts";

const logger = createLogger("desktop-test", {
  pretty: false,
  destination: { write: () => undefined },
});

/** A stand-in VNC server: greets, then echoes what it gets, reversed. */
const accepted: Socket[] = [];
const server = createServer((socket) => {
  accepted.push(socket);
  socket.write("RFB 003.008\n");
  socket.on("data", (bytes: Buffer) => {
    socket.write(Buffer.from([...bytes].reverse()));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
afterAll(() => {
  server.close();
});

async function eventually(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i += 1) await Bun.sleep(10);
  expect(check()).toBe(true);
}

describe("the desktop tunnel", () => {
  test("relays VNC bytes intact both ways, and says when the server hangs up", async () => {
    const out: Uint8Array[] = [];
    const frames: VmToGatewayFrame[] = [];
    const desktops = createDesktops({
      sendBinary: (message) => out.push(message),
      sendFrame: (frame) => frames.push(frame),
      logger,
      port,
    });
    desktops.open("hnd_1");
    const received = () =>
      out
        .map((message) => parseDesktopMessage(message))
        .filter((parsed) => parsed?.handoffId === "hnd_1")
        .flatMap((parsed) => [...(parsed?.bytes ?? [])]);
    await eventually(
      () =>
        new TextDecoder().decode(new Uint8Array(received())) ===
        "RFB 003.008\n",
    );
    const sent = new Uint8Array([1, 2, 0, 255, 10]);
    desktops.write("hnd_1", sent);
    await eventually(() => received().length === 12 + sent.length);
    expect(received().slice(12)).toEqual([...sent].reverse());

    accepted.at(-1)?.destroy();
    await eventually(() => frames.length === 1);
    expect(frames[0]).toMatchObject({
      type: "desktop.closed",
      handoffId: "hnd_1",
    });
  });

  test("closing it on purpose reports nothing back", async () => {
    const frames: VmToGatewayFrame[] = [];
    const desktops = createDesktops({
      sendBinary: () => undefined,
      sendFrame: (frame) => frames.push(frame),
      logger,
      port,
    });
    desktops.open("hnd_2");
    await Bun.sleep(50);
    desktops.closeAll();
    await Bun.sleep(50);
    expect(frames).toEqual([]);
  });
});
