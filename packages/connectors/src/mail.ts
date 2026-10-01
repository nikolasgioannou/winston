/**
 * The mail domain's normalized model and adapter interface (docs/design.md
 * §3, Handling provider differences; §11 `winston mail`). Every mail provider
 * implements `MailProvider`; Gmail is the only one today. Ids here are the
 * provider's own; the VM-facing API turns them into CLI ids (`msg_`, `thr_`,
 * `drf_`, `att_`).
 */

export interface MailAddress {
  name: string | null;
  email: string;
}

export interface MailAttachment {
  /** Stable within its message (the MIME part), not the provider's fetch token. */
  providerId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Where a message is, in the portable vocabulary (`--in`). */
export type MailFolder = "inbox" | "sent" | "drafts" | "archive" | "all";

export interface MailMessage {
  providerId: string;
  threadId: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  date: Date;
  snippet: string;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  /** User labels by name; system state is in the flags above. */
  labels: string[];
  attachments: MailAttachment[];
  /** The RFC 5322 Message-ID, for threading replies. */
  messageIdHeader: string | null;
}

/** A message with its body, as `mail get` shows it. */
export interface FullMailMessage extends MailMessage {
  /** Plain text: the text part, or the HTML part converted to text. */
  body: string;
  references: string[];
  replyTo: MailAddress[];
  /** Quoted earlier messages were left out of `body`. */
  quotedTextHidden: boolean;
}

export interface MailThread {
  providerId: string;
  subject: string;
  /** Oldest first. */
  messages: FullMailMessage[];
}

/** The portable filters shared by `search` and subscription filters (§11). */
export interface MailFilter {
  folder?: MailFolder | undefined;
  text?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  unread?: boolean | undefined;
  hasAttachment?: boolean | undefined;
  label?: string | undefined;
  category?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  /** The provider's own query syntax (`--native`), used as is. */
  native?: string | undefined;
}

export interface Page<T> {
  items: T[];
  /** Pass back to get the next page; null when there's no more. */
  cursor: string | null;
  /** The provider's estimate of everything that matched, when it has one. */
  estimatedTotal: number | null;
}

/** A message to send or save as a draft. */
export interface OutgoingMail {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  attachments?:
    { filename: string; mimeType: string; data: Uint8Array }[] | undefined;
  /** Replying or forwarding: the message it answers, to thread it. */
  inReplyTo?: { messageId: string; threadId: string } | undefined;
}

export interface SentMail {
  messageId: string;
  threadId: string;
}

export interface MailDraft extends SentMail {
  draftId: string;
}

/** State changes, as `mail update` names them. */
export interface MailChanges {
  read?: boolean | undefined;
  starred?: boolean | undefined;
  /** true archives (out of the inbox); false moves back to the inbox. */
  archived?: boolean | undefined;
  addLabels?: string[] | undefined;
  removeLabels?: string[] | undefined;
}

/** Reading mail: what every provider can do with the `read` capability. */
export interface MailReader {
  /** The account's own address, for "from" and for telling self from others. */
  readonly address: string;
  /** Messages matching the filters, newest first (`list` and `search`). */
  list(
    filter: MailFilter,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<Page<MailMessage>>;
  getMessage(messageId: string): Promise<FullMailMessage>;
  getThread(threadId: string): Promise<MailThread>;
  /** An attachment by its `MailAttachment.providerId`. */
  getAttachment(
    attachmentId: string,
  ): Promise<{ filename: string; mimeType: string; data: Uint8Array }>;
}

/** Reading and writing mail. */
export interface MailProvider extends MailReader {
  send(mail: OutgoingMail): Promise<SentMail>;
  createDraft(mail: OutgoingMail): Promise<MailDraft>;
  sendDraft(draftId: string): Promise<SentMail>;
  getDraft(draftId: string): Promise<FullMailMessage>;
  modify(
    target: { messages?: string[]; threads?: string[] },
    changes: MailChanges,
  ): Promise<void>;
  /** Moves to the trash, never deletes for good (§11 `mail delete`). */
  trash(target: {
    messages?: string[];
    threads?: string[];
    drafts?: string[];
  }): Promise<void>;
}
