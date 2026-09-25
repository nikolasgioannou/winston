import assert from "node:assert/strict";
import { test } from "bun:test";
import { cliCommandInputSchema, cliRequestSchema, cliResultSchema } from "@winston/contracts/cli";
import { commands, help } from "../src/commands";
import { runCli } from "../src/run";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("every public CLI contract has one discoverable command and an input schema", () => {
  const names = commands.map(({ command }) => command);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    [...names].sort(),
    cliRequestSchema.options.map((schema) => schema.shape.command.value).sort(),
  );
  for (const command of names) {
    const schema = cliCommandInputSchema(command);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal(object(object(schema.properties).command).const, command);
    assert.ok(JSON.stringify(schema).length < 100_000);
    assert.equal(help(command, true).commands.length, 1);
  }
  assert.throws(() => cliCommandInputSchema("not.a.command"));
  assert.ok(help("gmail").commands.every((entry) => !("requestSchema" in entry)));
  assert.ok(help(undefined, true).commands.every((entry) => !("requestSchema" in entry)));
});

test("generated request help exposes nested mutation fields and input defaults", () => {
  const gmail = object(cliCommandInputSchema("gmail.send").properties);
  const message = object(gmail.message);
  const fields = object(message.properties);
  const attachment = object(object(fields.attachments).items);
  assert.equal(message.additionalProperties, false);
  assert.ok("artifactId" in object(attachment.properties));
  assert.ok(!("path" in object(attachment.properties)));
  const calendar = object(cliCommandInputSchema("calendar.rsvp").properties);
  assert.deepEqual(object(calendar.response).enum, [
    "accepted",
    "tentative",
    "declined",
    "needsAction",
  ]);
  assert.deepEqual(object(calendar.sendUpdates).enum, ["all", "externalOnly", "none"]);
  const search = cliCommandInputSchema("gmail.search");
  assert.ok(Array.isArray(search.required));
  assert.ok(!search.required.includes("limit"));
});

test("exact JSON help is available without credentials or gateway execution", async () => {
  let calls = 0;
  const execute = () => {
    calls++;
    throw new Error("Help must not execute an operation.");
  };
  const output = await runCli(["calendar", "rsvp", "--help", "--json"], execute);
  assert.equal(output.exitCode, 0);
  assert.equal(calls, 0);
  const result = cliResultSchema.parse(JSON.parse(output.stdout));
  assert.equal(result.status, "ok");
  const entries = object(result.data).commands;
  assert.ok(Array.isArray(entries));
  const schema = object(object(entries[0]).requestSchema);
  assert.equal(object(object(schema.properties).command).const, "calendar.rsvp");
  const human = await runCli(["calendar", "rsvp", "--help"], execute);
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /--response/);
  assert.ok(!human.stdout.includes('"$schema"'));
  assert.equal(calls, 0);
});
