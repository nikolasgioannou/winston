/**
 * Receives a message locally, as if SES had (docs/runbooks/email.md, Local
 * development): local stacks don't get real mail, so this leaves a raw
 * message where SES would and queues the same `receive_mail` job.
 *
 *   bun run mail:receive <file.eml> [--to <address>]…
 *
 * Without --to, it's delivered to the message's To and Cc addresses on
 * Winston's domain. Verdicts are all PASS.
 */
import { parseMail } from "@winston/connectors/mail-parse";
import { createDb } from "@winston/db/client";
import { loadDbConfig } from "@winston/db/config";
import { enqueue } from "@winston/db/queue";
import { receiveMailJob, type ReceiveMailPayload } from "@winston/domain/jobs";
import { mailboxDomain } from "@winston/domain/mailbox";
import { parseArgs } from "node:util";
import { loadAgentsConfig } from "../config.ts";
import { localInboundMailStore } from "./stores.ts";

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { to: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  const [file] = positionals;
  if (!file) {
    console.error("Usage: bun run mail:receive <file.eml> [--to <address>]…");
    process.exit(1);
  }
  const raw = new Uint8Array(await Bun.file(file).arrayBuffer());
  const parsed = await parseMail(raw);
  const recipients =
    values.to ??
    [...parsed.to, ...parsed.cc]
      .map((a) => a.email.toLowerCase())
      .filter((email) => email.endsWith(`@${mailboxDomain}`));
  if (recipients.length === 0) {
    console.error(`No @${mailboxDomain} recipient: pass --to <address>.`);
    process.exit(1);
  }

  const sesMessageId = `local-${crypto.randomUUID()}`;
  const key = `inbound/${sesMessageId}`;
  await localInboundMailStore(loadAgentsConfig().INBOUND_MAIL_DIR).put(
    key,
    raw,
  );
  const { DATABASE_URL, DATABASE_SECRET_ARN } = loadDbConfig();
  const db = createDb(DATABASE_URL, { rdsSecretArn: DATABASE_SECRET_ARN });
  try {
    const pass = "PASS";
    const payload: ReceiveMailPayload = {
      key,
      sesMessageId,
      recipients,
      verdicts: { spf: pass, dkim: pass, dmarc: pass, spam: pass, virus: pass },
    };
    await enqueue(db, receiveMailJob.type, {
      payload,
      dedupeKey: receiveMailJob.dedupeKey(sesMessageId),
    });
    console.log(
      `Queued "${parsed.subject}" for ${recipients.join(", ")}; agents will store it.`,
    );
  } finally {
    await db.$client.end();
  }
}
