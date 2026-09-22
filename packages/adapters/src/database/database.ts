import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { checkSchema } from "./migrations";
import { ownerRepository, type OwnerRepository } from "./owners";
import { eventRepository, type EventRepository } from "./events";
import { conversationRepository, type ConversationRepository } from "./conversations";
import { taskRepository, type TaskRepository } from "./tasks";
import { telegramOutboundRepository, type TelegramOutboundRepository } from "./telegram-outbound";
import { memoryRepository, type MemoryRepository } from "./memory";
import * as schema from "./schema";

export type OwnerTransaction = {
  readonly ownerId: string;
  readonly owners: OwnerRepository;
  readonly events: EventRepository;
  readonly conversations: ConversationRepository;
  readonly tasks: TaskRepository;
  readonly telegramOutbound: TelegramOutboundRepository;
  readonly memory: MemoryRepository;
};

export function createDatabase(options: {
  connectionString: string;
  onConnectionError: () => void;
}) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 8,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 540,
    query_timeout: 30_000,
    application_name: "winston",
  });

  // Never pass a provider error (which can contain connection details) to logging.
  pool.on("error", () => {
    options.onConnectionError();
  });
  const database = drizzle(pool, { schema });

  return {
    assertCompatible: () => checkSchema(pool),
    close: () => pool.end(),
    async transaction<Result>(ownerId: string, work: (scope: OwnerTransaction) => Promise<Result>) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
        throw new Error("An explicit valid owner ID is required for a database transaction.");
      }

      // No retries: a disconnected COMMIT has an unknown outcome and must be reconciled by the caller.
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL statement_timeout = '30s'`);

        return work({
          ownerId,
          owners: ownerRepository(transaction, ownerId),
          events: eventRepository(transaction, ownerId),
          conversations: conversationRepository(transaction, ownerId),
          tasks: taskRepository(transaction, ownerId),
          telegramOutbound: telegramOutboundRepository(transaction, ownerId),
          memory: memoryRepository(transaction, ownerId),
        });
      });
    },
  };
}
