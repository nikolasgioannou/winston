export function startDeviceSessionRuntime(options: {
  owners: (afterId?: string) => Promise<string[]>;
  expire: (ownerId: string) => Promise<unknown>;
  notice: (code: string) => void;
  intervalMs?: number;
}) {
  let cursor: string | undefined;
  let stopped = false;
  let active: Promise<void> | undefined;

  async function sweep() {
    const owners = await options.owners(cursor);
    for (const ownerId of owners) {
      if (stopped) return;
      cursor = ownerId;
      try {
        await options.expire(ownerId);
      } catch {
        options.notice("device-session-expiration-failed");
      }
    }
    if (owners.length < 100) cursor = undefined;
  }

  function tick() {
    if (stopped || active) return;
    active = sweep()
      .catch(() => {
        options.notice("device-session-enumeration-failed");
      })
      .finally(() => {
        active = undefined;
      });
  }

  const timer = setInterval(tick, options.intervalMs ?? 5000);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
