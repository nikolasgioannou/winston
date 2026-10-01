import { describe, expect, test } from "bun:test";
import { ec2VmProvider, type Ec2Sender } from "./ec2-provider.ts";

interface FakeVolume {
  VolumeId: string;
  AvailabilityZone: string;
  State: string;
  Tags: { Key: string; Value: string }[];
  FromSnapshot?: string;
}

/**
 * A small stand-in for EC2 with its eventual consistency: a new instance
 * isn't described at first, then is `pending`, then `running`; a volume is
 * `creating` before it's `available`, and attaching or detaching takes a
 * describe or two. Records each call by command name.
 */
function fakeEc2() {
  const calls: string[] = [];
  const volumes = new Map<string, FakeVolume>();
  const instances = new Map<string, { state: string; describes: number }>();
  const snapshots = new Map<
    string,
    { volumeId: string; user?: string; startTime?: Date; status?: string }
  >();
  const launches: Record<string, unknown>[] = [];
  let next = 0;
  const id = (prefix: string) => `${prefix}-${String(++next)}`;
  const notFound = (name: string) => Object.assign(new Error(name), { name });

  const handlers: Record<string, (input: Record<string, unknown>) => unknown> =
    {
      DescribeSubnetsCommand: (input) => ({
        Subnets: (input.SubnetIds as string[]).map((SubnetId, index) => ({
          SubnetId,
          AvailabilityZone: index === 0 ? "us-east-1a" : "us-east-1b",
        })),
      }),
      DescribeVolumesCommand: (input) => {
        if (input.VolumeIds) {
          const volume = volumes.get((input.VolumeIds as string[])[0] ?? "");
          if (!volume) throw notFound("InvalidVolume.NotFound");
          // Transitional states settle after one describe.
          const shown = { ...volume };
          if (volume.State === "creating") volume.State = "available";
          if (volume.State === "attaching") volume.State = "in-use";
          if (volume.State === "detaching") volume.State = "available";
          return { Volumes: [shown] };
        }
        const filters = input.Filters as { Name: string; Values: string[] }[];
        return {
          Volumes: [...volumes.values()].filter((volume) =>
            filters.every((filter) =>
              volume.Tags.some(
                (tag) =>
                  `tag:${tag.Key}` === filter.Name &&
                  filter.Values.includes(tag.Value),
              ),
            ),
          ),
        };
      },
      CreateVolumeCommand: (input) => {
        const spec = (
          input.TagSpecifications as { Tags: FakeVolume["Tags"] }[]
        )[0];
        const volume: FakeVolume = {
          VolumeId: id("vol"),
          AvailabilityZone: input.AvailabilityZone as string,
          State: "creating",
          Tags: spec?.Tags ?? [],
          ...(input.SnapshotId
            ? { FromSnapshot: input.SnapshotId as string }
            : {}),
        };
        volumes.set(volume.VolumeId, volume);
        return { ...volume };
      },
      RunInstancesCommand: (input) => {
        launches.push(input);
        const instanceId = id("i");
        instances.set(instanceId, { state: "pending", describes: 0 });
        return { Instances: [{ InstanceId: instanceId }] };
      },
      DescribeInstancesCommand: (input) => {
        const instanceId = (input.InstanceIds as string[])[0] ?? "";
        const instance = instances.get(instanceId);
        if (!instance) throw notFound("InvalidInstanceID.NotFound");
        instance.describes++;
        // Not described at all right after launch, then pending, then running.
        if (instance.describes === 1)
          throw notFound("InvalidInstanceID.NotFound");
        const state = instance.state;
        if (state === "pending") instance.state = "running";
        return {
          Reservations: [
            { Instances: [{ InstanceId: instanceId, State: { Name: state } }] },
          ],
        };
      },
      AttachVolumeCommand: (input) => {
        const volume = volumes.get(input.VolumeId as string);
        if (volume?.State !== "available") throw new Error("VolumeInUse");
        volume.State = "attaching";
        return {};
      },
      TerminateInstancesCommand: (input) => {
        const instanceId = (input.InstanceIds as string[])[0] ?? "";
        const instance = instances.get(instanceId);
        if (!instance) throw notFound("InvalidInstanceID.NotFound");
        instance.state = "terminated";
        for (const volume of volumes.values())
          if (volume.State === "in-use") volume.State = "detaching";
        return {};
      },
      StartInstancesCommand: () => ({}),
      StopInstancesCommand: () => ({}),
      DescribeSnapshotsCommand: (input) => {
        const filters = input.Filters as { Name: string; Values: string[] }[];
        const value = (name: string) =>
          filters.find((filter) => filter.Name === name)?.Values[0];
        return {
          Snapshots: [...snapshots]
            .filter(
              ([, snapshot]) =>
                (value("volume-id") === undefined ||
                  snapshot.volumeId === value("volume-id")) &&
                (value("tag:winston:user") === undefined ||
                  snapshot.user === value("tag:winston:user")) &&
                (value("status") === undefined ||
                  (snapshot.status ?? "completed") === value("status")),
            )
            .map(([SnapshotId, snapshot]) => ({
              SnapshotId,
              StartTime: snapshot.startTime,
            })),
        };
      },
      DeleteSnapshotCommand: (input) => {
        snapshots.delete(input.SnapshotId as string);
        return {};
      },
      DeleteVolumeCommand: (input) => {
        if (!volumes.delete(input.VolumeId as string))
          throw notFound("InvalidVolume.NotFound");
        return {};
      },
    };

  const client = {
    send: (command: { constructor: { name: string }; input: object }) => {
      const name = command.constructor.name;
      calls.push(name.replace(/Command$/, ""));
      const handler = handlers[name];
      if (!handler) throw new Error(`Unexpected ${name}`);
      return Promise.try(() =>
        handler(command.input as Record<string, unknown>),
      );
    },
  } as unknown as Ec2Sender;
  return { client, calls, volumes, instances, snapshots, launches };
}

const provider = (ec2: ReturnType<typeof fakeEc2>, timeoutMs = 1000) =>
  ec2VmProvider({
    client: ec2.client,
    launchTemplateName: "winston-vm",
    subnetIds: ["subnet-a", "subnet-b"],
    gatewayUrl: "wss://gateway.runwinston.com",
    pollMs: 1,
    timeoutMs,
    sleep: () => Promise.resolve(),
  });

describe("ec2VmProvider", () => {
  test("create makes a tagged data volume, launches in its zone with the boot settings, and attaches it", async () => {
    const ec2 = fakeEc2();
    const { instanceId, dataVolumeId } = await provider(ec2).create({
      userId: "usr_1",
      registrationToken: "reg_1",
    });

    expect(ec2.volumes.get(dataVolumeId)).toMatchObject({
      AvailabilityZone: "us-east-1a",
      State: "in-use",
    });
    const tags = Object.fromEntries(
      (ec2.volumes.get(dataVolumeId)?.Tags ?? []).map(({ Key, Value }) => [
        Key,
        Value,
      ]),
    );
    expect(tags).toMatchObject({
      "winston:role": "data",
      "winston:user": "usr_1",
    });
    const [launch] = ec2.launches;
    expect(launch).toMatchObject({
      LaunchTemplate: { LaunchTemplateName: "winston-vm" },
      SubnetId: "subnet-a",
    });
    expect(
      JSON.parse(Buffer.from(launch?.UserData as string, "base64").toString()),
    ).toEqual({
      winston: {
        gatewayUrl: "wss://gateway.runwinston.com",
        registrationToken: "reg_1",
      },
    });
    expect(instanceId).toStartWith("i-");
    // Waits through the lagging describes rather than failing on them.
    expect(ec2.calls).toEqual([
      "DescribeVolumes",
      "DescribeSubnets",
      "CreateVolume",
      "DescribeVolumes",
      "DescribeVolumes",
      "DescribeSubnets",
      "RunInstances",
      "DescribeInstances",
      "DescribeInstances",
      "DescribeInstances",
      "AttachVolume",
      "DescribeVolumes",
      "DescribeVolumes",
    ]);
  });

  test("a replacement instance gets the same data volume once the old one lets go", async () => {
    const ec2 = fakeEc2();
    const vms = provider(ec2);
    const first = await vms.create({ userId: "usr_1", registrationToken: "a" });
    await vms.destroy(first.instanceId);
    const second = await vms.create({
      userId: "usr_1",
      registrationToken: "b",
    });

    expect(second.dataVolumeId).toBe(first.dataVolumeId);
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(ec2.volumes.size).toBe(1);
    expect(ec2.calls.filter((call) => call === "CreateVolume")).toHaveLength(1);
  });

  test("destroyDataVolume deletes the volume, its snapshots and the user's earlier ones, and repeating it is fine", async () => {
    const ec2 = fakeEc2();
    const vms = provider(ec2);
    const { instanceId, dataVolumeId } = await vms.create({
      userId: "usr_1",
      registrationToken: "a",
    });
    ec2.snapshots.set("snap-1", { volumeId: dataVolumeId, user: "usr_1" });
    ec2.snapshots.set("snap-2", { volumeId: dataVolumeId, user: "usr_1" });
    // From the user's volume before a restore: same user, other volume.
    ec2.snapshots.set("snap-earlier", { volumeId: "vol-gone", user: "usr_1" });
    ec2.snapshots.set("snap-other", { volumeId: "vol-other", user: "usr_2" });

    await vms.destroy(instanceId);
    await vms.destroyDataVolume(dataVolumeId, "usr_1");
    await vms.destroyDataVolume(dataVolumeId, "usr_1");

    expect(ec2.volumes.size).toBe(0);
    expect([...ec2.snapshots.keys()]).toEqual(["snap-other"]);
  });

  test("restoreDataVolume makes a tagged volume from the user's latest completed snapshot; retireDataVolume deletes only the volume", async () => {
    const ec2 = fakeEc2();
    const vms = provider(ec2);
    ec2.snapshots.set("snap-old", {
      volumeId: "vol-a",
      user: "usr_1",
      startTime: new Date("2026-09-29T07:00:00Z"),
    });
    ec2.snapshots.set("snap-new", {
      volumeId: "vol-a",
      user: "usr_1",
      startTime: new Date("2026-09-30T07:00:00Z"),
    });
    ec2.snapshots.set("snap-pending", {
      volumeId: "vol-a",
      user: "usr_1",
      startTime: new Date("2026-10-01T07:00:00Z"),
      status: "pending",
    });
    ec2.snapshots.set("snap-someone-else", {
      volumeId: "vol-b",
      user: "usr_2",
      startTime: new Date("2026-10-01T08:00:00Z"),
    });

    const restored = await vms.restoreDataVolume("usr_1");
    expect(restored.snapshotId).toBe("snap-new");
    expect(ec2.volumes.get(restored.dataVolumeId)).toMatchObject({
      FromSnapshot: "snap-new",
      State: "available",
    });

    await vms.retireDataVolume(restored.dataVolumeId);
    await vms.retireDataVolume(restored.dataVolumeId);
    expect(ec2.volumes.size).toBe(0);
    expect(ec2.snapshots.size).toBe(4);

    expect(vms.restoreDataVolume("usr_nobody")).rejects.toThrow(
      /No completed snapshot/,
    );
  });

  test("status maps EC2's states onto ours, and a vanished instance is gone", async () => {
    const ec2 = fakeEc2();
    const vms = provider(ec2);
    const { instanceId } = await vms.create({
      userId: "usr_1",
      registrationToken: "a",
    });
    expect(await vms.status(instanceId)).toBe("running");
    await vms.destroy(instanceId);
    expect(await vms.status(instanceId)).toBe("gone");
    expect(await vms.status("i-never")).toBe("gone");
    // Destroying again, or something that never existed, is fine.
    await vms.destroy(instanceId);
    await vms.destroy("i-never");
  });

  test("gives up when EC2 never gets there", () => {
    const ec2 = fakeEc2();
    ec2.volumes.set("vol-stuck", {
      VolumeId: "vol-stuck",
      AvailabilityZone: "us-east-1a",
      State: "in-use",
      Tags: [
        { Key: "winston:role", Value: "data" },
        { Key: "winston:user", Value: "usr_1" },
      ],
    });
    expect(
      provider(ec2, 0).create({ userId: "usr_1", registrationToken: "a" }),
    ).rejects.toThrow(/Timed out waiting for volume vol-stuck/);
  });
});
