import { describe, expect, test } from "bun:test";
import { dockerEngine, dockerSocketPath } from "./docker-engine.ts";
import { dockerVmProvider } from "./docker-provider.ts";

// A real container, when Docker and the local image are available (not in CI).
const image = "winston-vm:local";
const engine = await dockerSocketPath()
  .then((socket) => dockerEngine(socket))
  .catch(() => undefined);
const imageReady =
  engine !== undefined &&
  (await engine.request("GET", `/images/${image}/json`)).status === 200;

describe.skipIf(!imageReady)("dockerVmProvider against Docker", () => {
  test("creates, starts, reports and destroys a VM container", async () => {
    if (!engine) return;
    const provider = dockerVmProvider({
      engine,
      image,
      gatewayUrl: "ws://host.docker.internal:3001",
    });
    const userId = `usr_integration_${String(Date.now())}`;
    const { instanceId, dataVolumeId } = await provider.create({
      userId,
      registrationToken: "test-token",
    });
    try {
      await provider.start(instanceId);
      expect(await provider.status(instanceId)).toBe("running");
      await provider.stop(instanceId);
      expect(await provider.status(instanceId)).toBe("stopped");
    } finally {
      await provider.destroy(instanceId);
      expect(await provider.status(instanceId)).toBe("gone");
      await engine.request("DELETE", `/volumes/${dataVolumeId}`);
    }
  }, 60_000);
});
