import { describe, expect, test } from "bun:test";
import type { GatewayToVmFrame } from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { createUpdates, type VmManifest } from "./updates.ts";

const logger = createLogger("updates-test", {
  pretty: false,
  destination: { write: () => undefined },
});

const manifest = (version: string): VmManifest => ({
  version,
  binaries: {
    winston: {
      key: `vm/${version}/winston`,
      sha256: "a".repeat(64),
      signature: "c2ln",
    },
    winstond: {
      key: `vm/${version}/winstond`,
      sha256: "b".repeat(64),
      signature: "c2ln",
    },
  },
});

function setup(published: VmManifest | undefined, holdMs = 1000) {
  let current = published;
  const sent: { vmId: string; frame: GatewayToVmFrame }[] = [];
  const updates = createUpdates({
    loadManifest: () => Promise.resolve(current),
    presign: (key) => Promise.resolve(`https://s3.example/${key}?signed`),
    send: (vmId, frame) => {
      sent.push({ vmId, frame });
      return true;
    },
    logger,
    holdMs,
  });
  return {
    updates,
    sent,
    publish: (next: VmManifest) => {
      current = next;
    },
  };
}

const settle = () => Bun.sleep(5);

describe("VM updates", () => {
  test("without a manifest (local development), nothing is offered or held", async () => {
    const { updates, sent } = setup(undefined);
    await updates.refresh();
    updates.hello("vm_1", {
      cliVersion: "0.1.1+a",
      winstondVersion: "0.1.1+a",
    });
    await updates.ready("vm_1");
    await settle();
    expect(sent).toEqual([]);
  });

  test("an outdated VM is offered presigned downloads; its work waits until it says hello on the new CLI", async () => {
    const { updates, sent } = setup(manifest("0.1.9+z"));
    await updates.refresh();
    updates.hello("vm_1", {
      cliVersion: "0.1.8+y",
      winstondVersion: "0.1.8+y",
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.frame).toMatchObject({
      type: "update.available",
      version: "0.1.9+z",
      binaries: {
        winston: { url: "https://s3.example/vm/0.1.9+z/winston?signed" },
        winstond: { url: "https://s3.example/vm/0.1.9+z/winstond?signed" },
      },
    });

    let released = false;
    const work = updates.ready("vm_1").then(() => {
      released = true;
    });
    await settle();
    expect(released).toBe(false);
    updates.hello("vm_1", {
      cliVersion: "0.1.9+z",
      winstondVersion: "0.1.8+y",
    });
    await work;
    expect(released).toBe(true);
  });

  test("a VM that doesn't update in time gets its work anyway, and waits only once per version", async () => {
    const { updates, publish } = setup(manifest("0.1.9+z"), 20);
    await updates.refresh();
    updates.hello("vm_1", {
      cliVersion: "0.1.8+y",
      winstondVersion: "0.1.9+z",
    });
    const waits = async () => {
      const started = Date.now();
      await updates.ready("vm_1");
      return Date.now() - started >= 15;
    };
    expect(await waits()).toBe(true);
    // Its next command doesn't wait again for the same version…
    expect(await waits()).toBe(false);
    // …but a newer version gets its own wait.
    publish(manifest("0.1.10+w"));
    await updates.refresh();
    expect(await waits()).toBe(true);
  });

  test("current VMs aren't offered anything; a newly published version reaches every connected VM", async () => {
    const { updates, sent, publish } = setup(manifest("0.1.9+z"));
    await updates.refresh();
    updates.hello("vm_1", {
      cliVersion: "0.1.9+z",
      winstondVersion: "0.1.9+z",
    });
    updates.hello("vm_2", {
      cliVersion: "0.1.9+z",
      winstondVersion: "0.1.9+z",
    });
    await updates.ready("vm_1");
    await settle();
    expect(sent).toEqual([]);

    publish(manifest("0.1.10+w"));
    await updates.refresh();
    await settle();
    expect(sent.map(({ vmId }) => vmId).sort()).toEqual(["vm_1", "vm_2"]);

    // A VM that has gone isn't offered anything.
    updates.disconnected("vm_2");
    publish(manifest("0.1.11+v"));
    await updates.refresh();
    await settle();
    expect(sent.slice(2).map(({ vmId }) => vmId)).toEqual(["vm_1"]);
  });
});
