import { z } from "zod";
import { deviceOperationSchema } from "./devices";
import { artifactSchema } from "./artifacts";

export const deviceFileWriteRequestSchema = z.strictObject({
  version: z.literal(1),
  key: z.string().min(1).max(100),
  id: z.uuid(),
  path: deviceOperationSchema.options[2].shape.path,
  overwrite: z.boolean(),
  artifactId: artifactSchema.shape.id,
  revision: artifactSchema.shape.revision,
});
export type DeviceFileWriteRequest = z.infer<typeof deviceFileWriteRequestSchema>;
