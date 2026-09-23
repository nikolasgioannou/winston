import type { ServerConfig } from "./config";
import { createApi, type ApiOptions } from "./http/app";
import { errorResponse } from "./http/errors";
import { maximumPublicationSize } from "@winston/contracts/artifacts";

export function startServer(config: ServerConfig, options: ApiOptions = {}) {
  const { app, lifecycle } = createApi(options);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: app.fetch,
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
