/**
 * `bun run vm:provision`: queues provisioning for the seeded user's VM
 * (`SEED_EMAIL`), for local development until account creation does it (M3).
 * The agents service (`bun dev`) runs the job.
 */
import { createDb } from "@winston/db/client";
import { dbConfigSchema } from "@winston/db/config";
import { enqueue } from "@winston/db/queue";
import { users } from "@winston/db/schema";
import { provisionVmJob } from "@winston/domain/jobs";
import { loadConfig } from "@winston/shared/config";
import { eq } from "drizzle-orm";
import { z } from "zod";

const config = loadConfig(dbConfigSchema.extend({ SEED_EMAIL: z.email() }));
const db = createDb(config.DATABASE_URL);
try {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, config.SEED_EMAIL));
  if (!user)
    throw new Error(
      `No user ${config.SEED_EMAIL}. Run ./scripts/setup.sh to seed it.`,
    );
  await enqueue(db, provisionVmJob.type, {
    userId: user.id,
    dedupeKey: provisionVmJob.dedupeKey(user.id),
  });
  console.log(`Queued provisioning for ${config.SEED_EMAIL}; bun dev runs it.`);
} finally {
  await db.$client.end();
}
