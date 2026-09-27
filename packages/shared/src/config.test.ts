import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "./config.ts";

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().positive(),
});

describe("loadConfig", () => {
  test("returns typed, frozen config for a valid environment", () => {
    const config = loadConfig(schema, {
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      PORT: "8080",
      UNRELATED: "ignored",
    });
    expect(config).toEqual({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      PORT: 8080,
    });
    expect(Object.isFrozen(config)).toBe(true);
    const port: number = config.PORT;
    expect(port).toBe(8080);
  });

  test("reports every problem at once", () => {
    expect(() => loadConfig(schema, { PORT: "not-a-number" })).toThrow(
      /Invalid configuration:\n {2}- DATABASE_URL: .+\n {2}- PORT: .+/,
    );
  });

  test("never includes values in the error", () => {
    const secret = "super-secret-value";
    let message = "";
    try {
      loadConfig(schema, { DATABASE_URL: secret, PORT: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("PORT");
    expect(message).not.toContain(secret);
  });
});
