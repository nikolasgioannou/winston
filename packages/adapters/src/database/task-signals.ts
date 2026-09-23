import { Client } from "pg";
import { taskSchema } from "@winston/contracts/tasks";

const revisionSchema = taskSchema.pick({ ownerId: true, id: true, revision: true });
type Watch = { ownerId: string; id: string; revision: number; controller: AbortController };

export async function startTaskSignals(options: {
  directConnectionString: string;
  onDisconnect: () => void;
}) {
  const watches = new Set<Watch>();
  let client: Client | undefined;
  let connected = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;

  function interrupt() {
    for (const watch of watches) watch.controller.abort();
  }

  async function connect() {
    const next = new Client({
      connectionString: options.directConnectionString,
      application_name: "winston-task-signals",
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
      keepAlive: true,
    });
    client = next;
    let lost = false;
    const available = () => !lost && !stopped;
    const disconnect = () => {
      if (lost) return;
      lost = true;
      connected = false;
      interrupt();
      if (!stopped) {
        options.onDisconnect();
        retry = setTimeout(() => {
          pending = connect().finally(() => {
            pending = undefined;
          });
        }, 1000);
      }
      void next.end().catch(() => {});
    };
    next.on("error", disconnect);
    next.on("end", disconnect);
    next.on("notification", (notification) => {
      if (notification.channel !== "winston_task_revision" || !notification.payload) return;
      try {
        const parsed = revisionSchema.safeParse(JSON.parse(notification.payload));
        if (!parsed.success) return;
        const update = parsed.data;
        for (const watch of watches) {
          if (
            watch.ownerId === update.ownerId &&
            watch.id === update.id &&
            watch.revision < update.revision
          )
            watch.controller.abort();
        }
      } catch {
        // Notifications contain no task content and are only an acceleration hint.
      }
    });
    try {
      await next.connect();
      await next.query("LISTEN winston_task_revision");
      if (available()) connected = true;
    } catch {
      disconnect();
    }
  }

  await connect();
  return {
    watch(ownerId: string, task: { id: string; revision: number }, controller: AbortController) {
      const watch = { ownerId, id: task.id, revision: task.revision, controller };
      watches.add(watch);
      if (!connected || stopped) controller.abort();
      // The caller must read the current durable task after subscribing, closing
      // the LISTEN/snapshot race. Durable fences remain authoritative.
      return () => {
        watches.delete(watch);
      };
    },
    async stop() {
      stopped = true;
      connected = false;
      clearTimeout(retry);
      interrupt();
      await client?.end().catch(() => {});
      await pending;
    },
  };
}
