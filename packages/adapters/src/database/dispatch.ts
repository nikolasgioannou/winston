import type { OwnerTransaction } from "./database";
import type { StoredEvent } from "./events";

type Database = {
  transaction<Result>(
    ownerId: string,
    work: (scope: OwnerTransaction) => Promise<Result>,
  ): Promise<Result>;
};

// Run from an authenticated owner's worker loop. Delivery is at least once, never exactly once.
export async function dispatchNext(
  database: Database,
  ownerId: string,
  destination: string,
  deliver: (event: StoredEvent, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const lease = await database.transaction(ownerId, ({ events }) => events.claim(destination));
  if (!lease) return "idle" as const;

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  let abortDelivery = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abortDelivery = () => {
      reject(new Error("Event delivery was cancelled or timed out."));
    };
    deadline.addEventListener("abort", abortDelivery, { once: true });
  });
  let delivered = false;

  try {
    deadline.throwIfAborted();
    await Promise.race([Promise.resolve().then(() => deliver(lease.event, deadline)), aborted]);
    deadline.throwIfAborted();
    delivered = true;
  } catch {
    // Persist a safe failure code, never transport errors containing tokens or payloads.
  } finally {
    deadline.removeEventListener("abort", abortDelivery);
  }

  const settled = await database.transaction(ownerId, ({ events }) =>
    events.settle(lease, delivered),
  );

  return settled
    ? delivered
      ? ("delivered" as const)
      : ("retry" as const)
    : ("lease-lost" as const);
}
