import { z } from "zod";
import { readCredentialCipher } from "@winston/adapters/credentials";

const schema = z.object({
  GOOGLE_CONNECTOR_CLIENT_ID: z.string().min(1),
  GOOGLE_CONNECTOR_CLIENT_SECRET: z.string().min(1),
});

export function readConnectionConfig(
  environment: Record<string, string | undefined>,
  authOrigin: string,
) {
  if (!environment.GOOGLE_CONNECTOR_CLIENT_ID && !environment.GOOGLE_CONNECTOR_CLIENT_SECRET)
    return undefined;
  const result = schema.safeParse(environment);
  if (!result.success) throw new Error("Google connector configuration is incomplete.");
  return {
    cipher: readCredentialCipher(environment),
    oauth: {
      clientId: result.data.GOOGLE_CONNECTOR_CLIENT_ID,
      clientSecret: result.data.GOOGLE_CONNECTOR_CLIENT_SECRET,
      redirectUri: `${authOrigin}/callbacks/google/connections`,
    },
  };
}
