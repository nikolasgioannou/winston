import { z } from "zod";

const schema = z.object({
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_ENDPOINT_URL_S3: z.url().refine((value) => new URL(value).protocol === "https:"),
  AWS_REGION: z.string().min(1).default("auto"),
  BUCKET_NAME: z.string().min(3),
});

export function readStorageConfig(environment: Record<string, string | undefined>) {
  if (
    !environment.AWS_ACCESS_KEY_ID &&
    !environment.AWS_SECRET_ACCESS_KEY &&
    !environment.BUCKET_NAME
  )
    return null;
  const result = schema.safeParse(environment);
  if (!result.success) throw new Error("Private object storage configuration is incomplete.");
  return {
    endpoint: result.data.AWS_ENDPOINT_URL_S3,
    region: result.data.AWS_REGION,
    bucket: result.data.BUCKET_NAME,
    accessKeyId: result.data.AWS_ACCESS_KEY_ID,
    secretAccessKey: result.data.AWS_SECRET_ACCESS_KEY,
  };
}
