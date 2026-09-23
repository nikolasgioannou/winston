import { z } from "zod";

// Only trusted provisioning selects destinations. Agents select workspace IDs, never URLs.
export const workspaceOriginSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.protocol !== "http:"
    )
      return false;
    return (
      ["127.0.0.1", "[::1]"].includes(url.hostname) ||
      (/^[a-z][a-z0-9-]{0,62}\.flycast$/.test(url.hostname) && !url.port)
    );
  })
  .transform((value) => new URL(value).origin);

export const workspaceRuntimeSchema = z.strictObject({
  workspaceId: z.uuid(),
  revision: z.number().int().nonnegative(),
  origin: workspaceOriginSchema,
});
export type WorkspaceRuntime = z.infer<typeof workspaceRuntimeSchema>;
