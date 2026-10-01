import { describe, expect, test } from "bun:test";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { rdsPassword } from "./client.ts";

/** A Secrets Manager stand-in returning each value in turn, like a rotation. */
function rotatingSecret(...values: string[]) {
  const asked: unknown[] = [];
  return {
    asked,
    client: {
      send: (command: GetSecretValueCommand) => {
        asked.push(command.input.SecretId);
        return Promise.resolve({ SecretString: values.shift() });
      },
    } as never,
  };
}

describe("rdsPassword", () => {
  test("reads the secret's current password for every new connection", async () => {
    const { client, asked } = rotatingSecret(
      JSON.stringify({ username: "postgres", password: "before" }),
      JSON.stringify({ username: "postgres", password: "after rotation" }),
    );
    const password = rdsPassword("arn:aws:secretsmanager:db", client);
    expect(await password()).toBe("before");
    expect(await password()).toBe("after rotation");
    expect(asked).toEqual([
      "arn:aws:secretsmanager:db",
      "arn:aws:secretsmanager:db",
    ]);
  });

  test("fails clearly when the secret has no password", () => {
    const { client } = rotatingSecret(JSON.stringify({ username: "postgres" }));
    expect(rdsPassword("arn", client)()).rejects.toThrow(/no password/);
  });
});
