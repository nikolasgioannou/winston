/**
 * Where users' VMs run (docs/design.md §8a): Docker locally, EC2 in
 * production (M4). Small and async, shaped for EC2: a separate data volume
 * that outlives the instance, and starts that take a minute or two.
 */
export interface VmProvider {
  kind: "docker" | "ec2";
  /**
   * Creates the instance and its data volume (or reuses the volume, so
   * recreating an instance keeps the user's files). Doesn't start it.
   * `dataVolumeId` names the volume to attach (a replacement or a restore).
   */
  create(input: {
    userId: string;
    registrationToken: string;
    dataVolumeId?: string | undefined;
  }): Promise<{
    instanceId: string;
    dataVolumeId: string;
  }>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  /** Removes the instance. The data volume stays; account deletion removes it. */
  destroy(instanceId: string): Promise<void>;
  /**
   * Deletes a data volume, and in production every snapshot of the user's
   * data (account deletion). One that's already gone is fine, so a retry
   * can repeat it.
   */
  destroyDataVolume(dataVolumeId: string, userId: string): Promise<void>;
  /**
   * A new data volume from the user's latest snapshot (restoring a VM,
   * docs/runbooks/vm-recovery.md). EC2 only.
   */
  restoreDataVolume(userId: string): Promise<{
    dataVolumeId: string;
    snapshotId: string;
    snapshotTakenAt: Date;
  }>;
  /** Deletes a volume a restore replaced, keeping its snapshots. */
  retireDataVolume(dataVolumeId: string): Promise<void>;
  status(instanceId: string): Promise<VmInstanceStatus>;
}

/** An instance's state as the provider sees it. `gone` means it no longer exists. */
export type VmInstanceStatus = "starting" | "running" | "stopped" | "gone";
