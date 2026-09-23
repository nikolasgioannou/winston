import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { checkSchema } from "./migrations";
import { ownerRepository, type OwnerRepository } from "./owners";
import { eventRepository, type EventRepository } from "./events";
import { conversationRepository, type ConversationRepository } from "./conversations";
import { taskRepository, type TaskRepository } from "./tasks";
import { taskStepRepository } from "./task-steps";
import { taskUpdateRepository } from "./task-updates";
import { handoffRepository } from "./handoffs";
import { telegramApprovalRepository } from "./telegram-approvals";
import { connectedReadRepository } from "./connected-reads";
import { filePublicationRepository } from "./file-publications";
import { telegramOutboundRepository, type TelegramOutboundRepository } from "./telegram-outbound";
import { memoryRepository, type MemoryRepository } from "./memory";
import { turnRepository, type TurnRepository } from "./turns";
import { credentialRepository, type CredentialRepository } from "./credentials";
import { connectionRepository, type ConnectionRepository } from "./connections";
import { capabilityRepository, capabilityHash, type CapabilityRepository } from "./capabilities";
import { serviceRequestSchema, type ServiceRequest } from "@winston/contracts/capabilities";
import * as schema from "./schema";
import { connectionTargetRepository, type ConnectionTargetRepository } from "./connection-targets";
import { authorizationRepository, type AuthorizationRepository } from "./authorization";
import { deviceRepository, deviceTokenHash, type DeviceRepository } from "./devices";
import { workspaceRepository, type WorkspaceRepository } from "./workspaces";
import { actionRepository, type ActionRepository } from "./actions";
import { artifactRepository, type ArtifactRepository } from "./artifacts";
import { taskResourceRepository, type TaskResourceRepository } from "./task-resources";
import { cliRepository } from "./cli";
import { workspaceRuntimeRepository } from "./workspace-runtimes";
import {
  deviceCredentialSchema,
  devicePairingTokenSchema,
} from "@winston/contracts/device-registry";

export type OwnerTransaction = {
  readonly filePublications: ReturnType<typeof filePublicationRepository>;
  readonly connectedReads: ReturnType<typeof connectedReadRepository>;
  readonly telegramApprovals: ReturnType<typeof telegramApprovalRepository>;
  readonly handoffs: ReturnType<typeof handoffRepository>;
  readonly taskUpdates: ReturnType<typeof taskUpdateRepository>;
  readonly taskSteps: ReturnType<typeof taskStepRepository>;
  readonly workspaceRuntimes: ReturnType<typeof workspaceRuntimeRepository>;
  readonly cli: ReturnType<typeof cliRepository>;
  readonly ownerId: string;
  readonly owners: OwnerRepository;
  readonly events: EventRepository;
  readonly conversations: ConversationRepository;
  readonly tasks: TaskRepository;
  readonly telegramOutbound: TelegramOutboundRepository;
  readonly memory: MemoryRepository;
  readonly turns: TurnRepository;
  readonly credentials: CredentialRepository;
  readonly connections: ConnectionRepository;
  readonly capabilities: CapabilityRepository;
  readonly devices: DeviceRepository;
  readonly authorization: AuthorizationRepository;
  readonly connectionTargets: ConnectionTargetRepository;
  readonly workspaces: WorkspaceRepository;
  readonly actions: ActionRepository;
  readonly artifacts: ArtifactRepository;
  readonly taskResources: TaskResourceRepository;
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
    async authenticateDevice(token: string) {
      const parsed = deviceCredentialSchema.safeParse(token);
      if (!parsed.success) return null;
      const result = await pool.query<{ ownerId: string; deviceId: string }>(
        'SELECT owner_id AS "ownerId", id AS "deviceId" FROM winston.devices WHERE token_hash = $1 AND revoked_at IS NULL',
        [deviceTokenHash(parsed.data)],
      );
      return result.rows[0] ?? null;
    },
    async authenticateDevicePairing(token: string) {
      const parsed = devicePairingTokenSchema.safeParse(token);
      if (!parsed.success) return null;
      const result = await pool.query<{ ownerId: string }>(
        'SELECT owner_id AS "ownerId" FROM winston.device_pairing WHERE secret_hash = $1 AND expires_at > clock_timestamp()',
        [deviceTokenHash(parsed.data)],
      );
      return result.rows[0] ?? null;
    },
    async authenticateService(input: ServiceRequest) {
      const parsed = serviceRequestSchema.safeParse(input);
      if (!parsed.success) return null;
      const rows = await pool.query<{ ownerId: string }>(
        'SELECT owner_id AS "ownerId" FROM winston.service_capabilities WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()',
        [capabilityHash(parsed.data.token)],
      );
      const ownerId = rows.rows[0]?.ownerId;
      if (!ownerId) return null;
      return database.transaction((transaction) =>
        capabilityRepository(transaction, ownerId).authenticate(parsed.data),
      );
    },
    // Trusted runtime enumeration only; never expose this cross-owner operation through owner HTTP routes.
    async telegramOwners(botId: number, afterId = "00000000-0000-0000-0000-000000000000") {
      const result = await pool.query<{ ownerId: string }>(
        'SELECT owner_id AS "ownerId" FROM winston.telegram_bindings WHERE bot_id = $1 AND owner_id > $2::uuid ORDER BY owner_id LIMIT 100',
        [botId, afterId],
      );
      return result.rows.map((row) => row.ownerId);
    },
    async transaction<Result>(ownerId: string, work: (scope: OwnerTransaction) => Promise<Result>) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
        throw new Error("An explicit valid owner ID is required for a database transaction.");
      }

      // No retries: a disconnected COMMIT has an unknown outcome and must be reconciled by the caller.
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL statement_timeout = '30s'`);

        return work({
          telegramApprovals: telegramApprovalRepository(transaction, ownerId),
          connectedReads: connectedReadRepository(transaction, ownerId),
          filePublications: filePublicationRepository(transaction, ownerId),
          handoffs: handoffRepository(transaction, ownerId),
          taskUpdates: taskUpdateRepository(transaction, ownerId),
          taskSteps: taskStepRepository(transaction, ownerId),
          workspaceRuntimes: workspaceRuntimeRepository(transaction, ownerId),
          cli: cliRepository(transaction, ownerId),
          ownerId,
          owners: ownerRepository(transaction, ownerId),
          events: eventRepository(transaction, ownerId),
          conversations: conversationRepository(transaction, ownerId),
          tasks: taskRepository(transaction, ownerId),
          telegramOutbound: telegramOutboundRepository(transaction, ownerId),
          memory: memoryRepository(transaction, ownerId),
          turns: turnRepository(transaction, ownerId),
          credentials: credentialRepository(transaction, ownerId),
          connections: connectionRepository(transaction, ownerId),
          capabilities: capabilityRepository(transaction, ownerId),
          devices: deviceRepository(transaction, ownerId),
          authorization: authorizationRepository(transaction, ownerId),
          connectionTargets: connectionTargetRepository(transaction, ownerId),
          workspaces: workspaceRepository(transaction, ownerId),
          actions: actionRepository(transaction, ownerId),
          artifacts: artifactRepository(transaction, ownerId),
          taskResources: taskResourceRepository(transaction, ownerId),
        });
      });
    },
  };
}
