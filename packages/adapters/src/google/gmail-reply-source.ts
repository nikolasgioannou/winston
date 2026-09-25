import { simpleParser } from "mailparser";
import { gmailReplyInspectionSchema } from "@winston/contracts/gmail-mutation-sources";
import { gmailReplySourceSchema } from "@winston/contracts/gmail-mutations";

// Parse bounded header text only; never render external HTML or infer reply recipients.
export async function readGmailReplySource(input: unknown) {
  const message = gmailReplyInspectionSchema.parse(input);
  const header = (name: string) => {
    const values = message.headers.filter((item) => item.name.toLowerCase() === name);
    if (values.length !== 1) throw new Error("Gmail reply source headers are ambiguous.");
    const value = values[0]?.value.replace(/\r?\n[ \t]+/g, " ").replace(/\t/g, " ");
    if (value === undefined || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
      throw new Error("Gmail reply source header is invalid.");
    return value;
  };
  const subject = header("subject");
  const parsed = await simpleParser(`Subject: ${subject}\r\n\r\n`, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });
  return gmailReplySourceSchema.parse({
    source: message.source,
    id: message.id,
    threadId: message.threadId,
    messageId: header("message-id").trim(),
    subject: parsed.subject ?? "",
  });
}
