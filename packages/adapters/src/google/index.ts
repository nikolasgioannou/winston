import { randomUUID } from "node:crypto";
import type { createDatabase } from "../database";
import type { createCredentialCipher } from "../credentials";
import {
  googleGrantSchema,
  googleScopes,
  type ConnectionStart,
  type Connection,
} from "@winston/contracts/connections";
import type { GoogleOAuth } from "./oauth";
import { readGoogleCalendars } from "./calendars";
import { createGoogleGrants } from "./grants";
import { GoogleAccessError } from "./errors";

export { createGoogleOAuth, type GoogleOAuth } from "./oauth";
export { GoogleAccessError } from "./errors";
export { createConnectionTargets, labelSearchResults } from "./targets";
export { createGmailReader, GmailReadError } from "./gmail";
export { createGmailMutationExecutor } from "./gmail-mutation-executor";
export { createGmailMutationGateway } from "./gmail-mutation-gateway";
export { formatGmailMutationApproval } from "./gmail-mutation-review";
export { createGmailLabelMutationGateway } from "./gmail-label-mutation-gateway";
export { formatGmailLabelMutationApproval } from "./gmail-label-mutation-review";
export { readGmailReplySource } from "./gmail-reply-source";
export {
  prepareGmailMutation,
  rebuildGmailMutation,
  readGmailMutationPlan,
  gmailMutationIntent,
} from "./gmail-mutation-plan";
export { createCalendarReader, CalendarReadError } from "./calendar-events";
export { prepareCalendarMutation, readCalendarMutationArguments } from "./calendar-mutation-plan";
export { createCalendarMutationExecutor } from "./calendar-mutation-executor";
export { formatCalendarMutationApproval } from "./calendar-mutation-review";
export { createCalendarMutationGateway } from "./calendar-mutation-gateway";
export { createCalendarReconciliationGateway } from "./calendar-reconciliation-gateway";
export {
  prepareGmailMessage,
  rebuildGmailMessage,
  type GmailAttachmentBytes,
} from "./gmail-message-preparation";
export { calendarMutationStateMatches } from "./calendar-reconciliation-evidence";
export { createCalendarAvailabilityReader } from "./calendar-availability";
export { createConnectedReadGateway } from "./cli-reads";

export function createGoogleConnections(options: {
  database: ReturnType<typeof createDatabase>;
  cipher: ReturnType<typeof createCredentialCipher>;
  oauth: GoogleOAuth;
  calendars?: typeof readGoogleCalendars;
}) {
  const { database, cipher, oauth } = options;
  const grants = createGoogleGrants(options);
  async function calendars(ownerId: string, id: string, signal: AbortSignal) {
    const stored = await database.transaction(ownerId, async (scope) => ({
      connection: await scope.connections.find(id),
      credential: await scope.credentials.find(id),
    }));
    if (
      !stored.connection ||
      stored.connection.service !== "calendar" ||
      !stored.connection.scopes.includes(googleScopes.calendar[0]) ||
      !stored.credential?.encrypted
    )
      throw new Error("Calendar connection unavailable.");
    const access = await grants.access(ownerId, id, signal);
    try {
      return await (options.calendars ?? readGoogleCalendars)(access.grant.accessToken, signal);
    } catch (error) {
      if (error instanceof GoogleAccessError && error.kind === "reconnect")
        await grants.rejected(ownerId, id, access.revision);
      throw error;
    }
  }
  return {
    access: grants.access,
    rejected: grants.rejected,
    disconnect: grants.disconnect,
    calendars,
    async selectCalendars(
      ownerId: string,
      id: string,
      revision: number,
      ids: string[],
      signal: AbortSignal,
    ) {
      const available = await calendars(ownerId, id, signal);
      if (ids.some((selected) => !available.some((calendar) => calendar.id === selected)))
        throw new Error("Selected calendar is unavailable to this account.");
      return database.transaction(ownerId, ({ connections }) =>
        connections.selectCalendars(id, revision, ids),
      );
    },
    list: (ownerId: string) =>
      database.transaction(ownerId, ({ connections }) => connections.list()),
    async startHandoff(ownerId: string, sessionId: string, id: string) {
      const attempt = await database.transaction(ownerId, async ({ handoffs, connections }) => {
        const handoff = await handoffs.find(id);
        if (handoff?.state !== "pending" || handoff.target.kind !== "connection") return null;
        const state = await connections.start(sessionId, {
          service: handoff.target.service,
          ...(handoff.target.connectionId ? { connectionId: handoff.target.connectionId } : {}),
          task: { id: handoff.taskId, revision: handoff.taskRevision, blockerId: handoff.id },
        });
        return { service: handoff.target.service, state };
      });
      return attempt ? { url: oauth.url(attempt.service, attempt.state) } : null;
    },
    async start(ownerId: string, sessionId: string, intent: ConnectionStart) {
      const state = await database.transaction(ownerId, ({ connections }) =>
        connections.start(sessionId, intent),
      );
      return { url: oauth.url(intent.service, state) };
    },
    async finish(
      ownerId: string,
      sessionId: string,
      state: string,
      code: string,
      signal: AbortSignal,
    ) {
      const challenge = await database.transaction(ownerId, ({ connections }) =>
        connections.claim(sessionId, state),
      );
      if (!challenge) throw new Error("Connection attempt is invalid or expired.");
      const grant = googleGrantSchema.parse(await oauth.exchange(code, state, signal));
      if (challenge.expectedSubject !== null && grant.subject !== challenge.expectedSubject)
        throw new Error("Choose the original Google account when reconnecting.");
      return database.transaction(ownerId, async (scope) => {
        const existing = await scope.connections.bySubject(grant.subject, challenge.intent.service);
        if (!challenge.intent.connectionId && existing)
          throw new Error("This account is already connected. Use reconnect instead.");
        const id = challenge.intent.connectionId ?? randomUUID();
        const credential = await scope.credentials.find(id);
        const previous = credential?.encrypted
          ? cipher.decrypt(credential, credential.encrypted)
          : undefined;
        const refreshToken = grant.refreshToken ?? previous?.refreshToken;
        if (!refreshToken)
          throw new Error("Offline access was not granted. Start a new connection attempt.");
        const revision = (credential?.revision ?? -1) + 1;
        const encrypted = cipher.encrypt(
          { ownerId, id, provider: "google", revision },
          {
            accessToken: grant.accessToken,
            refreshToken,
            expiresAt: grant.expiresAt,
            scopes: grant.scopes,
          },
        );
        await scope.credentials.put(id, credential?.revision ?? null, encrypted);
        const connection: Connection = {
          id,
          service: challenge.intent.service,
          subject: grant.subject,
          email: grant.email,
          scopes: grant.scopes,
          revision: (challenge.expectedRevision ?? -1) + 1,
          status: googleScopes[challenge.intent.service].every((required) =>
            grant.scopes.includes(required),
          )
            ? "connected"
            : "limited",
          calendars: existing?.calendars ?? [],
        };
        await scope.connections.complete(challenge, connection);
        const task = await scope.connections.currentTask(challenge.intent.task);
        if (task)
          await scope.handoffs.completeVerified(task.blockerId, {
            kind: "connection",
            connectionId: id,
          });
        await scope.events.publish({
          key: `${id}:${String(connection.revision)}`,
          type: "connection.connected",
          payload: { connectionId: id, service: connection.service, ...(task ? { task } : {}) },
          destinations: ["connection-runtime", "conversation-updates"],
        });
        return connection;
      });
    },
  };
}

export type GoogleConnections = ReturnType<typeof createGoogleConnections>;
export { createGmailDraftReader } from "./gmail-drafts";
export { createGmailLabelReader } from "./gmail-labels";
export { createGmailReconciliationGateway } from "./gmail-reconciliation-gateway";
export {
  prepareGmailLabelMutation,
  readGmailLabelMutationPlan,
  gmailLabelsMatch,
} from "./gmail-label-mutation-plan";
export { createGmailLabelMutationExecutor } from "./gmail-label-mutation-executor";
