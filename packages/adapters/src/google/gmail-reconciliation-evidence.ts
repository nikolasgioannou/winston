import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { simpleParser } from "mailparser";
import { maximumGmailMimeBytes } from "@winston/contracts/gmail-messages";

const transportHeaders = new Set([
  "received",
  "x-received",
  "delivered-to",
  "return-path",
  "authentication-results",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
  "dkim-signature",
  "x-google-dkim-signature",
  "x-gm-message-state",
  "x-google-smtp-source",
]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Conservative evidence: permit transport headers and header folding, but require the
// complete MIME body to match. Provider rewrites remain unknown rather than weakening proof.
async function evidence(raw: Buffer) {
  if (raw.length > maximumGmailMimeBytes) throw new Error("MIME evidence exceeds limit.");
  const boundary = raw.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > 100_000) throw new Error("MIME headers unavailable.");
  const parsed = await simpleParser(raw.subarray(0, boundary + 4), {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });
  const headers = parsed.headerLines
    .filter(({ key }) => !transportHeaders.has(key))
    .map(({ key, line }) => [
      key,
      line
        .slice(line.indexOf(":") + 1)
        .replace(/\r?\n[ \t]+/g, " ")
        .trim(),
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { headers, bodySha256: digest(raw.subarray(boundary + 4)) };
}

export async function gmailMutationMimeMatches(expected: Buffer, actual: Buffer) {
  try {
    return isDeepStrictEqual(await evidence(expected), await evidence(actual));
  } catch {
    return false;
  }
}
