import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { eventPublicationSchema, type EventPublication } from "@winston/contracts/events";
import type { DatabaseTransaction } from "./owners";
import { eventReceipts, events, outbox } from "./schema";

export type StoredEvent = typeof events.$inferSelect;
export type EventLease = {
  event: StoredEvent;
  destination: string;
  token: string;
  attempt: number;
};

export function eventRepository(transaction: DatabaseTransaction, ownerId: string) {
  const scopedEvent = (id: string) => and(eq(events.ownerId, ownerId), eq(events.id, id));
  const delivery = (eventId: string, destination: string) =>
    and(
      eq(outbox.ownerId, ownerId),
      eq(outbox.eventId, eventId),
      eq(outbox.destination, destination),
    );

  async function find(id: string) {
    const [event] = await transaction.select().from(events).where(scopedEvent(id));

    return event;
  }

  return {
    find,
    async publish(input: EventPublication) {
      const publication = eventPublicationSchema.parse(input);
      const payload = eventPublicationSchema.shape.payload.parse(
        JSON.parse(JSON.stringify(publication.payload)),
      );
      const id = createHash("sha256")
        .update(JSON.stringify([ownerId, publication.type, publication.key]))
        .digest("hex");
      const destinations = [...new Set(publication.destinations)].sort();

      await transaction
        .insert(events)
        .values({
          ownerId,
          id,
          type: publication.type,
          payload,
          destinations,
        })
        .onConflictDoNothing();
      const event = await find(id);

      if (
        !event ||
        !isDeepStrictEqual(event.payload, payload) ||
        !isDeepStrictEqual(event.destinations, destinations)
      ) {
        throw new Error("Event idempotency key conflicts with its original publication.");
      }

      await transaction
        .insert(outbox)
        .values(
          destinations.map((destination) => ({
            ownerId,
            eventId: id,
            destination,
          })),
        )
        .onConflictDoNothing();

      return event;
    },
    async claim(destination: string): Promise<EventLease | undefined> {
      const [pending] = await transaction
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.ownerId, ownerId),
            eq(outbox.destination, destination),
            isNull(outbox.deliveredAt),
            lte(outbox.availableAt, sql`clock_timestamp()`),
            or(isNull(outbox.leasedUntil), lte(outbox.leasedUntil, sql`clock_timestamp()`)),
          ),
        )
        .orderBy(asc(outbox.availableAt), asc(outbox.eventId))
        .limit(1)
        .for("update", { skipLocked: true });

      if (!pending) return undefined;

      const event = await find(pending.eventId);
      if (!event) throw new Error("Outbox event is missing.");

      const token = randomUUID();
      await transaction
        .update(outbox)
        .set({
          leaseToken: token,
          leasedUntil: sql`clock_timestamp() + interval '60 seconds'`,
          attempts: pending.attempts + 1,
        })
        .where(delivery(pending.eventId, destination));

      return { event, destination, token, attempt: pending.attempts + 1 };
    },
    async settle(lease: EventLease, delivered: boolean) {
      if (lease.event.ownerId !== ownerId) throw new Error("Event lease belongs to another owner.");

      const retryMilliseconds = Math.min(300_000, 1000 * 2 ** Math.min(lease.attempt - 1, 9));
      const changed = await transaction
        .update(outbox)
        .set({
          leaseToken: null,
          leasedUntil: null,
          ...(delivered
            ? { deliveredAt: sql`clock_timestamp()`, failureCode: null }
            : {
                availableAt: sql`clock_timestamp() + ${retryMilliseconds} * interval '1 millisecond'`,
                failureCode: "delivery-failed" as const,
              }),
        })
        .where(
          and(
            delivery(lease.event.id, lease.destination),
            eq(outbox.leaseToken, lease.token),
            sql`${outbox.leasedUntil} > clock_timestamp()`,
            isNull(outbox.deliveredAt),
          ),
        )
        .returning({ id: outbox.eventId });

      return changed.length === 1;
    },
    async status(eventId: string, destination: string) {
      const [status] = await transaction
        .select()
        .from(outbox)
        .where(delivery(eventId, destination));

      return status;
    },
    async consume(eventId: string, consumer: string, work: (event: StoredEvent) => Promise<void>) {
      const event = await find(eventId);
      if (!event) throw new Error("Event is unavailable to this owner.");
      if (!event.destinations.includes(consumer))
        throw new Error("Consumer is not an event destination.");

      return transaction.transaction(async (savepoint) => {
        const receipt = await savepoint
          .insert(eventReceipts)
          .values({
            ownerId,
            eventId,
            consumer,
          })
          .onConflictDoNothing()
          .returning({ id: eventReceipts.eventId });

        if (!receipt.length) return false;

        // The savepoint also rolls back scoped handler writes if the caller catches its failure.
        await work(event);

        return true;
      });
    },
  };
}

export type EventRepository = ReturnType<typeof eventRepository>;
