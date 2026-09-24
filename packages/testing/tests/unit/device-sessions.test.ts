import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { z } from "zod";
import { deviceSessionWelcomeSchema } from "@winston/contracts/device-registry";

const fixtures = z
  .strictObject({
    base: z.record(z.string(), z.unknown()),
    cases: z.array(
      z.strictObject({
        name: z.string(),
        valid: z.boolean(),
        changes: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../device-protocol/fixtures/sessions.json", import.meta.url),
        "utf8",
      ),
    ) as unknown,
  );

for (const fixture of fixtures.cases) {
  test(`session handshake: ${fixture.name}`, () => {
    assert.equal(
      deviceSessionWelcomeSchema.safeParse({ ...fixtures.base, ...fixture.changes }).success,
      fixture.valid,
    );
  });
}
