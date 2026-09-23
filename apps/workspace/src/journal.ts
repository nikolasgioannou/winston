import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  workspaceIdentitySchema,
  workspaceOperationSchema,
  workspaceOutcomeSchema,
  workspaceRecordSchema,
  type WorkspaceIdentity,
  type WorkspaceOperation,
  type WorkspaceOutcome,
  type WorkspaceRecord,
} from "@winston/contracts/workspace";
import { openVolume } from "./volume";

type Row = { request: string; state: WorkspaceRecord["state"]; outcome: string | null };

function record(row: Row): WorkspaceRecord {
  return workspaceRecordSchema.parse({
    request: JSON.parse(row.request) as unknown,
    state: row.state,
    outcome: row.outcome === null ? null : (JSON.parse(row.outcome) as unknown),
  });
}

export function openWorkspaceJournal(options: {
  root: string;
  identity: WorkspaceIdentity;
  initialize?: boolean;
}) {
  const identity = workspaceIdentitySchema.parse(options.identity);
  const initialize = options.initialize ?? false;
  const volume = openVolume(options.root, initialize);
  const database = new Database(volume.filename, { create: false, strict: true });

  try {
    database.run(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    if (initialize) {
      database
        .transaction(() => {
          database.run(`
          CREATE TABLE identity (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            version INTEGER NOT NULL,
            document TEXT NOT NULL
          );
          CREATE TABLE operations (
            id TEXT PRIMARY KEY,
            request TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'unknown')),
            completion_token TEXT,
            outcome TEXT
          );
        `);
          database.query("INSERT INTO identity VALUES (1, 1, ?)").run(JSON.stringify(identity));
        })
        .immediate();
    }
    const stored = database
      .query<{ version: number; document: string }, []>(
        "SELECT version, document FROM identity WHERE singleton = 1",
      )
      .get();
    if (!stored || stored.version !== 1 || stored.document !== JSON.stringify(identity)) {
      throw new Error("Workspace identity or journal version does not match.");
    }
  } catch (error) {
    database.close();
    throw error;
  }

  function validated(input: WorkspaceOperation) {
    volume.assertPresent();
    const request = workspaceOperationSchema.parse(input);
    if (
      request.identity.ownerId !== identity.ownerId ||
      request.identity.workspaceId !== identity.workspaceId
    ) {
      throw new Error("Operation belongs to another workspace.");
    }
    return request;
  }

  const find = database.query<Row, [string]>(
    "SELECT request, state, outcome FROM operations WHERE id = ?",
  );

  return {
    home: volume.home,
    assertPresent() {
      volume.assertPresent();
    },
    start(
      input: WorkspaceOperation,
    ): { started: true; completionToken: string } | { started: false; record: WorkspaceRecord } {
      const request = validated(input);
      return database
        .transaction(() => {
          const serialized = JSON.stringify(request);
          const existing = find.get(request.operationId);
          if (existing) {
            if (existing.request !== serialized)
              throw new Error("Operation ID was reused with different arguments or authority.");
            return { started: false as const, record: record(existing) };
          }
          const completionToken = randomUUID();
          database
            .query(
              "INSERT INTO operations (id, request, state, completion_token) VALUES (?, ?, 'running', ?)",
            )
            .run(request.operationId, serialized, completionToken);
          return { started: true as const, completionToken };
        })
        .immediate();
    },
    read(input: WorkspaceOperation) {
      const request = validated(input);
      const row = find.get(request.operationId);
      if (!row) return null;
      if (row.request !== JSON.stringify(request))
        throw new Error("Operation identity does not match.");
      return record(row);
    },
    finish(input: WorkspaceOperation, completionToken: string, inputOutcome: WorkspaceOutcome) {
      const request = validated(input);
      const outcome = workspaceOutcomeSchema.parse(inputOutcome);
      const updated = database
        .query(
          `
        UPDATE operations SET state = ?, outcome = ?, completion_token = NULL
        WHERE id = ? AND request = ? AND state = 'running' AND completion_token = ?
      `,
        )
        .run(
          outcome.state,
          JSON.stringify(outcome),
          request.operationId,
          JSON.stringify(request),
          completionToken,
        );
      return updated.changes === 1;
    },
    uncertain(input: WorkspaceOperation, completionToken: string) {
      const request = validated(input);
      return (
        database
          .query(
            `
        UPDATE operations SET state = 'unknown', completion_token = NULL
        WHERE id = ? AND request = ? AND state = 'running' AND completion_token = ?
      `,
          )
          .run(request.operationId, JSON.stringify(request), completionToken).changes === 1
      );
    },
    // Call only after exclusive runtime ownership is established and old execution has stopped.
    // An uncertain external effect is never retried by recovering its journal entry.
    recoverInterrupted() {
      volume.assertPresent();
      return database
        .query(
          "UPDATE operations SET state = 'unknown', completion_token = NULL WHERE state = 'running'",
        )
        .run().changes;
    },
    close() {
      database.close();
    },
  };
}
