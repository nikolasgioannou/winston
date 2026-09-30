import { DockerApiError, type DockerEngine } from "./docker-engine.ts";
import type { VmInstanceStatus, VmProvider } from "./provider.ts";

export interface DockerProviderOptions {
  engine: DockerEngine;
  /** The image `bun run image:build:local` builds. */
  image: string;
  /** Where `winstond` dials the gateway from inside the container. */
  gatewayUrl: string;
}

const containerName = (userId: string) => `winston-vm-${userId}`;
const volumeName = (userId: string) => `winston-home-${userId}`;

/** The Engine API's error body. */
const errorMessage = (body: unknown) =>
  (body as { message?: string } | undefined)?.message ?? "unexpected response";

/**
 * Users' VMs as local Docker containers (docs/design.md §8a, §18). Each runs
 * `winston-vm:local` with systemd as PID 1, using the flags validated in the
 * systemd spike, and a named volume at /home/winston standing in for the EBS
 * data volume.
 */
export function dockerVmProvider({
  engine,
  image,
  gatewayUrl,
}: DockerProviderOptions): VmProvider {
  /** Calls the Engine API and throws unless the status is one of `ok`. */
  const call = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    ok: number[],
    body?: unknown,
  ) => {
    const response = await engine.request(method, path, body);
    if (!ok.includes(response.status))
      throw new DockerApiError(
        response.status,
        path,
        errorMessage(response.body),
      );
    return response;
  };

  return {
    kind: "docker",

    async create({ userId, registrationToken }) {
      const volume = volumeName(userId);
      await call("POST", "/volumes/create", [200, 201], {
        Name: volume,
        Labels: { "winston.user": userId },
      });
      const config = {
        Image: image,
        Hostname: "winston",
        Env: [
          `WINSTON_REGISTRATION_TOKEN=${registrationToken}`,
          `WINSTON_GATEWAY_URL=${gatewayUrl}`,
        ],
        Labels: { "winston.user": userId },
        HostConfig: {
          CgroupnsMode: "host",
          Binds: [
            "/sys/fs/cgroup:/sys/fs/cgroup:rw",
            `${volume}:/home/winston`,
          ],
          Tmpfs: { "/run": "", "/run/lock": "" },
          ExtraHosts: ["host.docker.internal:host-gateway"],
          RestartPolicy: { Name: "unless-stopped" },
        },
      };
      const name = containerName(userId);
      const createPath = `/containers/create?name=${name}`;
      let created = await engine.request("POST", createPath, config);
      if (created.status === 409) {
        // Left from an earlier attempt: replace it, so it gets the new token.
        await call("DELETE", `/containers/${name}?force=true`, [204, 404]);
        created = await engine.request("POST", createPath, config);
      }
      const id = (created.body as { Id?: string } | undefined)?.Id;
      if (created.status !== 201 || !id)
        throw new DockerApiError(
          created.status,
          createPath,
          errorMessage(created.body),
        );
      return { instanceId: id, dataVolumeId: volume };
    },

    async start(instanceId) {
      // 304: already running.
      await call("POST", `/containers/${instanceId}/start`, [204, 304]);
    },

    async stop(instanceId) {
      await call("POST", `/containers/${instanceId}/stop?t=10`, [204, 304]);
    },

    async destroy(instanceId) {
      await call("DELETE", `/containers/${instanceId}?force=true`, [204, 404]);
    },

    async destroyDataVolume(dataVolumeId) {
      await call("DELETE", `/volumes/${dataVolumeId}?force=true`, [204, 404]);
    },

    async status(instanceId): Promise<VmInstanceStatus> {
      const response = await call(
        "GET",
        `/containers/${instanceId}/json`,
        [200, 404],
      );
      if (response.status === 404) return "gone";
      const state = (response.body as { State?: { Status?: string } }).State;
      switch (state?.Status ?? "") {
        case "running":
          return "running";
        case "restarting":
          return "starting";
        case "removing":
          return "gone";
        default:
          // created, paused, exited, dead
          return "stopped";
      }
    },
  };
}
