import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  artifactMetadataSchema,
  artifactSchema,
  type Artifact,
  type ArtifactMetadata,
} from "@winston/contracts/artifacts";
import type { DatabaseTransaction } from "./owners";
import { eventRepository } from "./events";

export function artifactRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function publish(artifact: Artifact) {
    await eventRepository(transaction, ownerId).publish({
      key: `artifact:${artifact.id}:${String(artifact.revision)}`,
      type: "artifact.changed",
      payload: { artifactId: artifact.id, state: artifact.state, revision: artifact.revision },
      destinations: ["artifact-runtime"],
    });
  }
  async function find(inputId: string, lock = false) {
    const id = artifactSchema.shape.id.parse(inputId);
    const result = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.artifacts WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      ${lock ? sql`FOR SHARE` : sql``}
    `);
    return result.rows[0] ? artifactSchema.parse(result.rows[0].document) : null;
  }

  async function transition(
    inputId: string,
    inputRevision: number,
    from: Artifact["state"][],
    state: Artifact["state"],
  ) {
    const id = artifactSchema.shape.id.parse(inputId);
    const revision = artifactSchema.shape.revision.parse(inputRevision);
    const result = await transaction.execute<{ document: unknown }>(sql`
      UPDATE winston.artifacts SET document = document || jsonb_build_object('state', ${state}::text, 'revision', ${revision + 1}::int),
        updated_at = clock_timestamp()
      WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
        AND (document->>'revision')::int = ${revision}
        AND document->>'state' IN (${sql.join(
          from.map((value) => sql`${value}`),
          sql`, `,
        )})
      RETURNING document
    `);
    if (!result.rows[0]) return null;
    const artifact = artifactSchema.parse(result.rows[0].document);
    await publish(artifact);
    return artifact;
  }

  return {
    find,
    async findByKey(key: string) {
      if (!key || key.length > 200) throw new Error("Invalid artifact request key.");
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.artifacts
        WHERE owner_id = ${ownerId}::uuid AND request_key = ${key}
      `);
      return result.rows[0] ? artifactSchema.parse(result.rows[0].document) : null;
    },
    async prepare(inputKey: string, inputMetadata: ArtifactMetadata) {
      if (!inputKey || inputKey.length > 200) throw new Error("Invalid artifact request key.");
      const metadata = artifactMetadataSchema.parse(inputMetadata);
      const owner = await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      if (!owner.rowCount) throw new Error("Owner unavailable.");
      const existing = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.artifacts WHERE owner_id = ${ownerId}::uuid AND request_key = ${inputKey}
      `);
      if (existing.rows[0]) {
        const artifact = artifactSchema.parse(existing.rows[0].document);
        if (JSON.stringify(artifact.metadata) !== JSON.stringify(metadata))
          throw new Error("Artifact request conflicts with existing metadata.");
        return { artifact, created: false };
      }
      const id = randomUUID();
      const artifact: Artifact = {
        id,
        metadata,
        state: "uploading",
        revision: 0,
        object: { id, ownerId, purpose: "artifact", size: metadata.size, sha256: metadata.sha256 },
      };
      await transaction.execute(sql`
        INSERT INTO winston.artifacts (owner_id, id, request_key, document)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${inputKey}, ${JSON.stringify(artifact)}::jsonb)
      `);
      await publish(artifact);
      return { artifact, created: true };
    },
    async list(afterId = "00000000-0000-0000-0000-000000000000") {
      const after = artifactSchema.shape.id.parse(afterId);
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.artifacts WHERE owner_id = ${ownerId}::uuid
          AND document->>'state' = 'ready' AND id > ${after}::uuid ORDER BY id LIMIT 100
      `);
      return result.rows.map((row) => artifactSchema.parse(row.document));
    },
    // Trusted transfer verification only, never an owner/model-provided state transition.
    ready: (id: string, revision: number) =>
      transition(id, revision, ["uploading", "verifying"], "ready"),
    uncertain: (id: string, revision: number) =>
      transition(id, revision, ["uploading"], "verifying"),
    fail: (id: string, revision: number) => transition(id, revision, ["uploading"], "failed"),
    beginDelete: (id: string, revision: number) =>
      transition(id, revision, ["ready", "failed", "verifying"], "deleting"),
    finishDelete: (id: string, revision: number) =>
      transition(id, revision, ["deleting"], "deleted"),
  };
}

export type ArtifactRepository = ReturnType<typeof artifactRepository>;
