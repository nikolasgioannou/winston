import type { ServerConfig } from "./config";
import { createApi, type ApiOptions } from "./http/app";
import { errorResponse } from "./http/errors";
import { maximumPublicationSize } from "@winston/contracts/artifacts";
import type { createDeviceSocketTransport, DeviceSocketData } from "./devices/socket";

export function startServer(
  config: ServerConfig,
  options: ApiOptions & { deviceTransport?: ReturnType<typeof createDeviceSocketTransport> } = {},
) {
  const { app, lifecycle } = createApi(options);
  const server = Bun.serve<DeviceSocketData>({
    hostname: config.hostname,
    port: config.port,
    fetch(request, server) {
      if (options.deviceTransport && new URL(request.url).pathname === "/api/devices/socket") {
        if (lifecycle.draining) return errorResponse("unavailable", crypto.randomUUID());
        return options.deviceTransport.upgrade(request, server);
      }
      return app.fetch(request);
    },
    websocket: options.deviceTransport?.websocket ?? { message() {} },
    maxRequestBodySize: maximumPublicationSize,
    idleTimeout: 60,
    error: () => errorResponse("internal_error", crypto.randomUUID()),
  });

  lifecycle.started = true;
  let stopping: Promise<void> | undefined;

  async function drain() {
    lifecycle.draining = true;

    const timeout = setTimeout(() => {
      server.stop(true).catch(() => {
        process.exitCode = 1;
      });
    }, config.shutdownTimeoutMs);

    try {
      await options.deviceTransport?.stop();
      await server.stop();
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    server,
    stop: () => {
      stopping ??= drain();

      return stopping;
    },
  };
}
