import { eq, sql } from "drizzle-orm";
import { validTimezone, type TimezoneProfile } from "@winston/contracts/timezone";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];
export type Owner = typeof schema.owners.$inferSelect;

export interface OwnerRepository {
  find(): Promise<Owner | undefined>;
  ensure(): Promise<Owner>;
  timezone(): Promise<TimezoneProfile>;
  updateTimezone(
    timezone: string | undefined,
    revision: number,
  ): Promise<{ profile: TimezoneProfile; conflict: boolean }>;
}

function timezoneProfile(owner: Owner): TimezoneProfile {
  return {
    timezone: owner.timezone,
    revision: owner.timezoneRevision,
    observedAt: owner.timezoneObservedAt?.toISOString() ?? null,
    source: owner.timezoneSource,
  };
}

export function ownerRepository(
  transaction: DatabaseTransaction,
  ownerId: string,
): OwnerRepository {
  return {
    async timezone() {
      const [owner] = await transaction
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.id, ownerId));

      if (!owner) {
        throw new Error("Owner profile is missing.");
      }

      return timezoneProfile(owner);
    },
    async updateTimezone(timezone, revision) {
      // Lock the scoped profile so revision checks and updates form one atomic operation.
      const [owner] = await transaction
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.id, ownerId))
        .for("update");

      if (!owner) {
        throw new Error("Owner profile is missing.");
      }

      if (!validTimezone(timezone)) {
        return { profile: timezoneProfile(owner), conflict: false };
      }

      if (owner.timezone === timezone && owner.timezoneSource === "browser") {
        return { profile: timezoneProfile(owner), conflict: false };
      }

      if (owner.timezoneRevision !== revision) {
        return { profile: timezoneProfile(owner), conflict: true };
      }

      const [updated] = await transaction
        .update(schema.owners)
        .set({
          timezone,
          timezoneRevision: revision + 1,
          timezoneObservedAt: sql`clock_timestamp()`,
          timezoneSource: "browser",
        })
        .where(eq(schema.owners.id, ownerId))
        .returning();

      if (!updated) {
        throw new Error("Owner profile was not updated.");
      }

      return { profile: timezoneProfile(updated), conflict: false };
    },
    async find() {
      const rows = await transaction
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.id, ownerId));

      return rows[0];
    },
    async ensure() {
      await transaction.insert(schema.owners).values({ id: ownerId }).onConflictDoNothing();
      const rows = await transaction
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.id, ownerId));
      const owner = rows[0];

      if (!owner) throw new Error("Owner was not created.");

      return owner;
    },
  };
}
