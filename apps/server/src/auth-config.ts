import { z } from "zod";

const origin = z.url().refine((value) => {
  const url = new URL(value);

  return (
    url.origin === value &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
  );
});

const schema = z.object({
  DATABASE_URL: z.url(),
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
  BETTER_AUTH_SECRET: z.string().min(32),
  OWNER_EMAIL: z.email(),
  GOOGLE_CLIENT_ID: z.string().trim().min(1),
  GOOGLE_CLIENT_SECRET: z.string().trim().min(1),
});

export function readAuthConfig(environment: Record<string, string | undefined>) {
  const result = schema.safeParse(environment);

  if (!result.success) {
    throw new Error(
      `Invalid authentication configuration: ${result.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    );
  }

  const data = result.data;

  return {
    connectionString: data.DATABASE_URL,
    auth: {
      baseURL: data.BETTER_AUTH_URL,
      webOrigin: data.WEB_ORIGIN,
      ownerEmail: data.OWNER_EMAIL,
      secret: data.BETTER_AUTH_SECRET,
      clientId: data.GOOGLE_CLIENT_ID,
      clientSecret: data.GOOGLE_CLIENT_SECRET,
    },
  };
}
