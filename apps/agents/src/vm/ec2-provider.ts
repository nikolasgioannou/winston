import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type Volume,
} from "@aws-sdk/client-ec2";
import type { VmInstanceStatus, VmProvider } from "./provider.ts";

/** What the provider sends commands through: `EC2Client`, or a fake in tests. */
export type Ec2Sender = Pick<EC2Client, "send">;

export interface Ec2ProviderOptions {
  client?: Ec2Sender;
  /** The Vm stack's launch template, `winston-vm`. */
  launchTemplateName: string;
  /** The public subnets, one per availability zone. */
  subnetIds: string[];
  /** Where `winstond` dials the gateway: wss://gateway.runwinston.com. */
  gatewayUrl: string;
  /** A new data volume's size. */
  dataVolumeGiB?: number;
  /** Waiting on EC2: poll interval and how long before giving up. */
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
}

/** The tags the Vm stack's policies match (infra/src/vm.ts). */
const roleTag = "winston:role";
const userTag = "winston:user";

/** EC2 says an id doesn't exist (any more). */
const notFound = (error: unknown) =>
  ((error as { name?: string }).name ?? "").includes("NotFound");

/**
 * Users' VMs on EC2 (docs/design.md §10, §17), from the Vm stack's launch
 * template.
 *
 * - **The data volume** is created on its own and attached, rather than in
 *   `RunInstances`: it's tagged `winston:role=data` (what the nightly
 *   snapshots and the backend's permissions match), it outlives every
 *   instance, and a replacement instance attaches the same one. A user's
 *   volume is found by its `winston:user` tag, so `create` reuses it.
 * - **The instance** launches in the volume's availability zone with user
 *   data carrying the gateway URL and the one-time registration token, which
 *   `winstond` reads through IMDSv2. It starts at once (EC2 has no "created
 *   but stopped"), so `start` after `create` is a no-op.
 * - **Eventual consistency:** every step waits for the state it needs by
 *   polling describe calls, so a lagging describe never fails a step.
 */
export function ec2VmProvider({
  client = new EC2Client(),
  launchTemplateName,
  subnetIds,
  gatewayUrl,
  dataVolumeGiB = 20,
  pollMs = 3000,
  timeoutMs = 300_000,
  sleep = Bun.sleep,
}: Ec2ProviderOptions): VmProvider {
  /** Polls `check` until it returns a value, or throws after `timeoutMs`. */
  const waitFor = async <T>(
    what: string,
    check: () => Promise<T | undefined>,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check().catch((error: unknown) => {
        // A describe can lag a create; that's not a failure yet.
        if (notFound(error)) return undefined;
        throw error;
      });
      if (value !== undefined) return value;
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${what}.`);
      await sleep(pollMs);
    }
  };

  const describeVolume = async (volumeId: string) =>
    (await client.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] })))
      .Volumes?.[0];

  const instanceState = async (instanceId: string) =>
    (
      await client.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      )
    ).Reservations?.[0]?.Instances?.[0]?.State?.Name;

  let subnetsByZone: Map<string, string> | undefined;
  const subnetIn = async (zone: string) => {
    if (!subnetsByZone) {
      const { Subnets = [] } = await client.send(
        new DescribeSubnetsCommand({ SubnetIds: subnetIds }),
      );
      subnetsByZone = new Map(
        Subnets.map((subnet) => [
          subnet.AvailabilityZone ?? "",
          subnet.SubnetId ?? "",
        ]),
      );
    }
    const subnet = subnetsByZone.get(zone);
    if (!subnet) throw new Error(`No subnet in ${zone} for the VM.`);
    return subnet;
  };

  /** The user's data volume, if they have one that isn't being deleted. */
  const existingVolume = async (
    userId: string,
  ): Promise<Volume | undefined> => {
    const { Volumes = [] } = await client.send(
      new DescribeVolumesCommand({
        Filters: [
          { Name: `tag:${roleTag}`, Values: ["data"] },
          { Name: `tag:${userTag}`, Values: [userId] },
        ],
      }),
    );
    return Volumes.find(
      (volume) => volume.State !== "deleting" && volume.State !== "deleted",
    );
  };

  const newVolume = async (userId: string) => {
    // The first subnet's zone; the instance follows the volume.
    const [firstSubnet] = subnetIds;
    if (!firstSubnet) throw new Error("No subnets for VMs.");
    const { Subnets = [] } = await client.send(
      new DescribeSubnetsCommand({ SubnetIds: [firstSubnet] }),
    );
    const zone = Subnets[0]?.AvailabilityZone;
    if (!zone) throw new Error(`Subnet ${firstSubnet} has no zone.`);
    return client.send(
      new CreateVolumeCommand({
        AvailabilityZone: zone,
        Size: dataVolumeGiB,
        VolumeType: "gp3",
        Encrypted: true,
        TagSpecifications: [
          {
            ResourceType: "volume",
            Tags: [
              { Key: "Name", Value: `winston-home-${userId}` },
              { Key: roleTag, Value: "data" },
              { Key: userTag, Value: userId },
            ],
          },
        ],
      }),
    );
  };

  return {
    kind: "ec2",

    async create({ userId, registrationToken }) {
      const volume =
        (await existingVolume(userId)) ?? (await newVolume(userId));
      const volumeId = volume.VolumeId;
      const zone = volume.AvailabilityZone;
      if (!volumeId || !zone) throw new Error("EC2 returned no volume.");
      // A replaced instance's volume detaches as it terminates.
      await waitFor(`volume ${volumeId} to be available`, async () =>
        (await describeVolume(volumeId))?.State === "available"
          ? true
          : undefined,
      );

      const userData = JSON.stringify({
        winston: { gatewayUrl, registrationToken },
      });
      const { Instances = [] } = await client.send(
        new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateName: launchTemplateName },
          MinCount: 1,
          MaxCount: 1,
          SubnetId: await subnetIn(zone),
          UserData: Buffer.from(userData).toString("base64"),
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: [
                { Key: "Name", Value: `winston-vm-${userId}` },
                { Key: roleTag, Value: "vm" },
                { Key: userTag, Value: userId },
              ],
            },
            {
              ResourceType: "volume",
              Tags: [
                { Key: roleTag, Value: "root" },
                { Key: userTag, Value: userId },
              ],
            },
          ],
        }),
      );
      const instanceId = Instances[0]?.InstanceId;
      if (!instanceId) throw new Error("EC2 launched no instance.");

      await waitFor(`instance ${instanceId} to run`, async () =>
        (await instanceState(instanceId)) === "running" ? true : undefined,
      );
      // The second disk; the AMI mounts whichever disk isn't the root.
      await client.send(
        new AttachVolumeCommand({
          VolumeId: volumeId,
          InstanceId: instanceId,
          Device: "/dev/sdf",
        }),
      );
      await waitFor(`volume ${volumeId} to attach`, async () =>
        (await describeVolume(volumeId))?.State === "in-use" ? true : undefined,
      );
      return { instanceId, dataVolumeId: volumeId };
    },

    async start(instanceId) {
      const state = await instanceState(instanceId);
      if (state === "running" || state === "pending") return;
      await client.send(
        new StartInstancesCommand({ InstanceIds: [instanceId] }),
      );
    },

    async stop(instanceId) {
      await client.send(
        new StopInstancesCommand({ InstanceIds: [instanceId] }),
      );
    },

    async destroy(instanceId) {
      try {
        await client.send(
          new TerminateInstancesCommand({ InstanceIds: [instanceId] }),
        );
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    async destroyDataVolume(dataVolumeId) {
      // Snapshots first: they name the volume, which may be gone already.
      const { Snapshots = [] } = await client.send(
        new DescribeSnapshotsCommand({
          OwnerIds: ["self"],
          Filters: [{ Name: "volume-id", Values: [dataVolumeId] }],
        }),
      );
      for (const { SnapshotId } of Snapshots)
        if (SnapshotId)
          await client.send(new DeleteSnapshotCommand({ SnapshotId }));

      // A terminating instance releases the volume shortly.
      const gone = await waitFor(
        `volume ${dataVolumeId} to detach`,
        async () => {
          const volume = await describeVolume(dataVolumeId).catch(
            (error: unknown) => {
              if (notFound(error)) return null;
              throw error;
            },
          );
          if (volume === null || volume?.State === "deleted") return "gone";
          return volume?.State === "available" ? "available" : undefined;
        },
      );
      if (gone === "gone") return;
      try {
        await client.send(new DeleteVolumeCommand({ VolumeId: dataVolumeId }));
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    async status(instanceId): Promise<VmInstanceStatus> {
      const state = await instanceState(instanceId).catch((error: unknown) => {
        if (notFound(error)) return "terminated";
        throw error;
      });
      switch (state ?? "terminated") {
        case "pending":
          return "starting";
        case "running":
          return "running";
        case "stopping":
        case "stopped":
          return "stopped";
        default:
          // shutting-down, terminated, or no longer described.
          return "gone";
      }
    },
  };
}
