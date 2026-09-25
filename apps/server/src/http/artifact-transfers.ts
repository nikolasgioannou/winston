import { Hono } from "hono";
import type { createDatabase } from "@winston/adapters/database";
import { artifactTransferSchema } from "@winston/contracts/artifacts";
import { canonicalJson } from "@winston/contracts/json";
import type { HttpEnvironment, Identity } from "./app";
import { parseJson, RequestError } from "./errors";
import { createInboxTransferGroup } from "./inbox-transfers";

export function createFileTransferGroup(
  database: Pick<
    ReturnType<typeof createDatabase>,
    "authenticateInboxTransfer" | "authenticateArtifactTransfer"
  >,
) {
  const inbox = createInboxTransferGroup(database);
  const token = (request: Request) =>
    request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
  const router = new Hono<HttpEnvironment>();
  router.route("/", inbox.router);
  router.post("/artifacts/authorize", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "transfer") throw new RequestError("unauthorized");
    const expected = await parseJson(context, artifactTransferSchema);
    const current = await database.authenticateArtifactTransfer(token(context.req.raw));
    if (
      !current ||
      current.ownerId !== identity.ownerId ||
      current.workspaceId !== identity.workspaceId ||
      canonicalJson(current) !== canonicalJson(expected)
    )
      throw new RequestError("forbidden");
    return context.json(current);
  });
  return {
    router,
    async authenticate(request: Request): Promise<Identity | null> {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/api/transfers/artifacts/authorize"
      )
        return inbox.authenticate(request);
      const current = await database.authenticateArtifactTransfer(token(request));
      return current
        ? { kind: "transfer", ownerId: current.ownerId, workspaceId: current.workspaceId }
        : null;
    },
  };
}
