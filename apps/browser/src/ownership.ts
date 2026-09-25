import {
  browserAccessSchema,
  browserLeaseSchema,
  browserOwnershipSchema,
  type BrowserAccess,
  type BrowserLease,
  type BrowserOwnership,
} from "@winston/contracts/browser";

export class BrowserOwnershipError extends Error {
  constructor() {
    super("Browser control is unavailable, expired, or has changed.");
  }
}

// The service must hold the profile's exclusive process lock for this gate's lifetime.
// Only trusted authority code may call transitions, after validating owner/task/permissions.
export async function openBrowserOwnership(options: {
  previous: BrowserOwnership;
  persist: (state: BrowserOwnership) => Promise<void>;
  disconnectViewers: () => Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let state = browserOwnershipSchema.parse(options.previous);
  let healthy = true;
  let transitioning = false;
  let leaseAbort = new AbortController();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const active = new Set<Promise<unknown>>();
  let tail = Promise.resolve();

  function serial<T>(run: () => Promise<T>) {
    const result = tail.then(run);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function matches(phase: "agent" | "human", access: BrowserAccess) {
    const parsed = browserAccessSchema.safeParse(access);
    return (
      healthy &&
      !transitioning &&
      !leaseAbort.signal.aborted &&
      parsed.success &&
      state.phase === phase &&
      state.epoch === parsed.data.epoch &&
      state.holder === parsed.data.holder &&
      state.expiresAt > now()
    );
  }

  function requireAccess(phase: "agent" | "human", access: BrowserAccess) {
    if (!matches(phase, access)) throw new BrowserOwnershipError();
  }

  function validLease(lease: BrowserLease) {
    const parsed = browserLeaseSchema.parse(lease);
    if (parsed.expiresAt <= now() || parsed.expiresAt > now() + 600_000)
      throw new BrowserOwnershipError();
    return parsed;
  }

  async function transition(next: Omit<BrowserOwnership, "epoch"> | BrowserOwnership) {
    if (!healthy) throw new BrowserOwnershipError();
    transitioning = true;
    clearTimeout(leaseTimer);
    leaseAbort.abort();
    try {
      const updated = browserOwnershipSchema.parse({ ...next, epoch: state.epoch + 1 });
      state = updated;
      await options.disconnectViewers();
      await options.persist({ ...updated });
      leaseAbort = new AbortController();
      if (state.phase !== "frozen") {
        leaseTimer = setTimeout(
          () => {
            leaseAbort.abort();
          },
          Math.max(0, state.expiresAt - now()),
        );
        leaseTimer.unref();
      }
      return { ...state };
    } catch {
      healthy = false;
      state = { phase: "frozen", epoch: state.epoch };
      throw new BrowserOwnershipError();
    } finally {
      transitioning = false;
    }
  }

  // Never restore active browser authority after a broker process restart.
  await transition({ phase: "frozen" });

  return {
    snapshot: () => ({ ...state }),
    allowsHuman: (access: BrowserAccess) => matches("human", access),
    activateAgent(lease: BrowserLease) {
      const requested = browserLeaseSchema.parse(lease);
      return serial(async () => {
        if (state.phase !== "frozen" || active.size) throw new BrowserOwnershipError();
        return transition({ phase: "agent", ...validLease(requested) });
      });
    },
    async runAgent<T>(access: BrowserAccess, run: (signal: AbortSignal) => Promise<T>) {
      const bound = browserAccessSchema.parse(access);
      requireAccess("agent", bound);
      if (active.size) throw new BrowserOwnershipError();
      const signal = leaseAbort.signal;
      const operation = Promise.resolve().then(async () => {
        requireAccess("agent", bound);
        const result = await run(signal);
        requireAccess("agent", bound);
        return result;
      });
      active.add(operation);
      try {
        return await operation;
      } finally {
        active.delete(operation);
      }
    },
    async takeOver(access: BrowserAccess, lease: BrowserLease, signal: AbortSignal) {
      const bound = browserAccessSchema.parse(access);
      const requested = browserLeaseSchema.parse(lease);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const pending = await serial(async () => {
        requireAccess("agent", bound);
        deadline.throwIfAborted();
        return transition({ phase: "pending", ...validLease(requested) });
      });
      const drained = Promise.allSettled([...active]);
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          drained,
          new Promise<never>((_resolve, reject) => {
            abort = () => {
              reject(new BrowserOwnershipError());
            };
            deadline.addEventListener("abort", abort, { once: true });
            if (deadline.aborted) abort();
          }),
        ]);
        return await serial(async () => {
          deadline.throwIfAborted();
          if (state.phase !== "pending" || state.epoch !== pending.epoch || active.size)
            throw new BrowserOwnershipError();
          return transition({ phase: "human", ...validLease(requested) });
        });
      } catch {
        await serial(async () => {
          if (state.phase === "pending" && state.epoch === pending.epoch)
            await transition({ phase: "frozen" });
        });
        throw new BrowserOwnershipError();
      } finally {
        if (abort) deadline.removeEventListener("abort", abort);
      }
    },
    returnToAgent(access: BrowserAccess, lease: BrowserLease) {
      const bound = browserAccessSchema.parse(access);
      const requested = browserLeaseSchema.parse(lease);
      return serial(async () => {
        requireAccess("human", bound);
        if (active.size) throw new BrowserOwnershipError();
        return transition({ phase: "agent", ...validLease(requested) });
      });
    },
    freeze() {
      return serial(() => transition({ phase: "frozen" }));
    },
  };
}
