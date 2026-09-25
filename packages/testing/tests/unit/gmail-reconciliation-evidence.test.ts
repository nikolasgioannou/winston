import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "bun:test";
import { prepareGmailMessage } from "@winston/adapters/google";
import { gmailMutationMimeMatches } from "../../../adapters/src/google/gmail-reconciliation-evidence";

test("Gmail evidence requires complete approved headers and attachment bytes", async () => {
  const bytes = Buffer.from("Exact attachment");
  const artifactId = randomUUID();
  const { raw } = await prepareGmailMessage(
    {
      operationId: randomUUID(),
      preparedAt: "2026-09-25T00:00:00.000Z",
      target: {
        connectionId: randomUUID(),
        connectionRevision: 0,
        preferencesRevision: 0,
        calendarId: null,
        email: "owner@example.com",
        label: "Owner",
        operation: "gmail.send",
      },
      message: {
        from: { email: "owner@example.com" },
        to: [{ email: "guest@example.com" }],
        cc: [],
        bcc: [{ email: "private@example.com" }],
        subject: "Exact subject",
        text: "Exact body",
        html: "<p>Exact body</p>",
        reply: null,
        attachments: [
          {
            artifactId,
            revision: 0,
            name: "sample.txt",
            mediaType: "text/plain",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      },
    },
    [{ artifactId, revision: 0, bytes }],
  );
  assert.equal(await gmailMutationMimeMatches(raw, raw), true);
  assert.equal(
    await gmailMutationMimeMatches(
      raw,
      Buffer.concat([Buffer.from("Received: by synthetic.example\r\n"), raw]),
    ),
    true,
  );
  const original = raw.toString("utf8");
  for (const changed of [
    original.replace("private@example.com", "other@example.com"),
    original.replace(/Bcc:[^\r]+\r\n/, ""),
    `Bcc: other@example.com\r\n${original}`,
    original.replace("Exact subject", "Changed subject"),
    original.replace(bytes.toString("base64"), Buffer.from("Other attachment").toString("base64")),
    `${original}extra body`,
    `Sender: attacker@example.com\r\n${original}`,
    "malformed",
  ]) {
    assert.notEqual(changed, original);
    assert.equal(await gmailMutationMimeMatches(raw, Buffer.from(changed)), false);
  }
});
