import type { z } from "zod";

/**
 * Validates environment variables against `schema` and returns the typed,
 * frozen result. On failure it throws one error listing every problem, naming
 * the variable but never echoing its value (values may be secrets).
 */
export function loadConfig<Schema extends z.ZodType<Record<string, unknown>>>(
  schema: Schema,
  env: Record<string, string | undefined> = process.env,
): Readonly<z.output<Schema>> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return Object.freeze(result.data);
}
