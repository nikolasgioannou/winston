/**
 * Test helpers for the VM-facing API's connector routes: a recording fake
 * mail provider and a request helper with a run token.
 */
import type {
  CalendarEvent,
  CalendarFilter,
  CalendarProvider,
  EventChanges,
  NewEvent,
  SeriesScope,
} from "@winston/connectors/calendar";
import type {
  FullMailMessage,
  MailChanges,
  MailFilter,
  MailProvider,
  OutgoingMail,
} from "@winston/connectors/mail";
import type { RampProvider } from "@winston/connectors/ramp";
import type { DbOrTx } from "@winston/db/client";
import { mintRunToken } from "@winston/domain/run-token";
import { createVmApi } from "./index.ts";
import type { Jev } from "./jev.ts";
import type { SiteDeps } from "./sites.ts";

export const testSecret = "vm-api-test-secret-0123456789abcdef";

export const fakeMessage = (
  id: string,
  overrides: Partial<FullMailMessage> = {},
): FullMailMessage => ({
  providerId: id,
  threadId: "t-1",
  from: { name: "Dana Reyes", email: "dana@example.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  subject: `Subject ${id}`,
  date: new Date("2026-09-25T20:02:00Z"),
  snippet: "snippet",
  unread: true,
  starred: false,
  inInbox: true,
  labels: [],
  attachments: [],
  messageIdHeader: `<${id}@mail.example.com>`,
  body: `Body of ${id}`,
  references: [],
  replyTo: [],
  quotedTextHidden: false,
  ...overrides,
});

export const withAttachment = fakeMessage("m-1", {
  attachments: [
    {
      providerId: "m-1/1",
      filename: "lease.pdf",
      mimeType: "application/pdf",
      size: 10,
    },
  ],
});

/** A mail provider that records what it's asked to do. */
export function fakeMail() {
  const filters: MailFilter[] = [];
  const sent: OutgoingMail[] = [];
  const drafted: OutgoingMail[] = [];
  const modified: {
    target: { messages?: string[]; threads?: string[] };
    changes: MailChanges;
  }[] = [];
  const trashed: {
    messages?: string[];
    threads?: string[];
    drafts?: string[];
  }[] = [];
  const draftsSent: string[] = [];
  const provider: MailProvider = {
    address: "me@example.com",
    list: (filter, page) => {
      filters.push(filter);
      return Promise.resolve({
        items: [withAttachment, fakeMessage("m-2")].slice(0, page.limit),
        cursor: "next-page",
        estimatedTotal: 7,
      });
    },
    getMessage: (id) =>
      Promise.resolve(id === "m-1" ? withAttachment : fakeMessage(id)),
    getThread: (id) =>
      Promise.resolve({
        providerId: id,
        subject: "Lease",
        messages: [fakeMessage("m-1"), fakeMessage("m-2")],
      }),
    getAttachment: () =>
      Promise.resolve({
        filename: "lease.pdf",
        mimeType: "application/pdf",
        data: new Uint8Array([1, 2, 3]),
      }),
    send: (mail) => {
      sent.push(mail);
      return Promise.resolve({
        messageId: "m-sent",
        threadId: mail.inReplyTo?.threadId ?? "t-new",
      });
    },
    createDraft: (mail) => {
      drafted.push(mail);
      return Promise.resolve({
        draftId: "r-1",
        messageId: "m-draft",
        threadId: "t-new",
      });
    },
    sendDraft: (id) => {
      draftsSent.push(id);
      return Promise.resolve({ messageId: "m-sent", threadId: "t-new" });
    },
    getDraft: () => Promise.resolve(fakeMessage("m-draft")),
    modify: (target, changes) => {
      modified.push({ target, changes });
      return Promise.resolve();
    },
    trash: (target) => {
      trashed.push(target);
      return Promise.resolve();
    },
  };
  return { provider, filters, sent, drafted, modified, trashed, draftsSent };
}

export const fakeEvent = (
  id: string,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  providerId: `me@example.com/${id}`,
  calendarId: "me@example.com",
  title: `Event ${id}`,
  start: { at: new Date("2026-09-29T19:00:00Z") },
  end: { at: new Date("2026-09-29T19:30:00Z") },
  allDay: false,
  location: null,
  description: null,
  organizer: { email: "me@example.com", name: null, self: true },
  attendees: [],
  myResponse: null,
  status: "confirmed",
  videoLink: null,
  recurrence: null,
  seriesId: null,
  htmlLink: null,
  updatedAt: null,
  ...overrides,
});

const dana = {
  email: "dana@other.com",
  name: "Dana",
  response: "accepted",
  optional: false,
  self: false,
} as const;

/** What `get` returns beyond fakeEvent's defaults: a meeting with Dana, and an invitation. */
const gotten: Record<string, Partial<CalendarEvent>> = {
  e1: {
    attendees: [
      dana,
      {
        email: "me@example.com",
        name: null,
        response: "accepted",
        optional: false,
        self: true,
      },
    ],
  },
  invite: {
    organizer: { email: "boss@other.com", name: null, self: false },
    attendees: [
      {
        email: "me@example.com",
        name: null,
        response: "needs_action",
        optional: false,
        self: true,
      },
    ],
  },
};

/** A calendar provider that records filters and writes, and returns fixed events and busy times. */
export function fakeCalendar() {
  const filters: CalendarFilter[] = [];
  const created: { event: NewEvent; notify: boolean }[] = [];
  const updated: {
    id: string;
    changes: EventChanges;
    scope: SeriesScope;
    notify: boolean;
  }[] = [];
  const deleted: { id: string; scope: SeriesScope; notify: boolean }[] = [];
  const answered: {
    id: string;
    response: string;
    note?: string | undefined;
    scope: string;
  }[] = [];
  const reader: CalendarProvider = {
    address: "me@example.com",
    listCalendars: () =>
      Promise.resolve([
        {
          id: "me@example.com",
          name: "me@example.com",
          primary: true,
          writable: true,
          timeZone: "America/New_York",
        },
      ]),
    list: (filter) => {
      filters.push(filter);
      return Promise.resolve({
        items: [
          fakeEvent("e1", {
            attendees: [dana],
            videoLink: "https://meet.google.com/x",
            seriesId: "me@example.com/series",
          }),
          fakeEvent("trip", {
            start: { date: "2026-09-30" },
            end: { date: "2026-10-01" },
            allDay: true,
          }),
        ],
        cursor: null,
      });
    },
    get: (id) => {
      const key = id.split("/")[1] ?? id;
      return Promise.resolve(fakeEvent(key, gotten[key] ?? {}));
    },
    freeBusy: ({ attendees }) =>
      Promise.resolve(
        new Map([
          // Tuesday Sep 29, busy 10–11 local (EDT).
          [
            "me@example.com",
            [
              {
                start: new Date("2026-09-29T14:00:00Z"),
                end: new Date("2026-09-29T15:00:00Z"),
              },
            ],
          ],
          ...attendees.map(
            (a) =>
              [
                a,
                a === "hidden@x.com"
                  ? ("unknown" as const)
                  : [
                      {
                        start: new Date("2026-09-29T19:00:00Z"),
                        end: new Date("2026-09-29T20:00:00Z"),
                      },
                    ],
              ] as const,
          ),
        ]),
      ),
    create: (event, { notify }) => {
      created.push({ event, notify });
      return Promise.resolve(
        fakeEvent("new", {
          title: event.title,
          start: event.start,
          end: event.end,
        }),
      );
    },
    update: (id, changes, { scope, notify }) => {
      updated.push({ id, changes, scope, notify });
      return Promise.resolve(
        fakeEvent(id.split("/")[1] ?? id, { title: changes.title ?? "Moved" }),
      );
    },
    delete: (id, { scope, notify }) => {
      deleted.push({ id, scope, notify });
      return Promise.resolve();
    },
    rsvp: (id, response, { note, scope }) => {
      answered.push({ id, response, note, scope });
      return Promise.resolve(
        fakeEvent(id.split("/")[1] ?? id, { myResponse: response }),
      );
    },
  };
  return { reader, filters, created, updated, deleted, answered };
}

/** The API over `tx` with the fake provider and VM files; `as(userId)` makes calls. */
/** A recording fake Ramp provider (02441f): one of each object. */
export function fakeRamp() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const transaction = {
    providerId: "tx-1",
    time: "2026-09-25T20:02:00Z",
    amount: "$42.50",
    originalAmount: null,
    merchant: "Uber",
    category: "Taxi",
    spentBy: "Ada Lovelace",
    state: "CLEARED",
    declineReason: null,
    memo: null,
    trip: null,
    fund: "Travel",
    missing: ["receipt"],
    link: null,
  };
  const provider: RampProvider = {
    transactions: record("transactions", {
      items: [transaction],
      cursor: "c2",
    }),
    transaction: record("transaction", {
      providerId: "tx-1",
      time: transaction.time,
      amount: "42.50",
      merchant: "Uber",
      spentBy: "Ada Lovelace",
      memo: null,
      fund: "Travel",
      coding: [],
    }),
    reimbursements: record("reimbursements", { items: [], cursor: null }),
    reimbursement: record("reimbursement", {
      providerId: "rb-1",
      date: "2026-09-20",
      submittedAt: null,
      amount: "$18.00",
      merchant: "Parking",
      memo: null,
      status: "DRAFT",
      coding: [],
      missing: [],
      link: null,
    }),
    requests: record("requests", { items: [], cursor: null }),
    request: record("request", {
      providerId: "rq-1",
      kind: "PURCHASE_ORDER",
      name: "Laptops",
      vendor: null,
      requester: "Dana Reyes",
      amount: "$4,000.00",
      status: "PENDING",
      date: "2026-09-24",
      reason: null,
    }),
    bills: record("bills", { items: [], cursor: null }),
    bill: record("bill", {
      providerId: "bl-1",
      vendor: "AWS",
      amount: "$120.00",
      invoice: null,
      dueDate: "2026-10-10",
      approvalStatus: "PENDING",
      paymentStatus: "UNPAID",
      pastDue: false,
      draft: false,
      memo: null,
      link: null,
      description: null,
      lineItems: [],
    }),
    setMemo: record("setMemo", undefined),
    comment: record("comment", undefined),
    submitReimbursement: record("submitReimbursement", undefined),
    decide: record("decide", undefined),
    attention: record("attention", [
      {
        kind: "TRANSACTION_APPROVALS",
        name: "Transaction approvals",
        total: 1,
        tasks: [
          {
            kind: "APPROVE_TRANSACTION",
            summary: "Uber · $42.50",
            objects: [{ kind: "rampTransaction" as const, providerId: "tx-1" }],
          },
        ],
      },
    ]),
  };
  return { provider, calls };
}

export function setupApi(
  tx: DbOrTx,
  vmFileContents: Record<string, string | Uint8Array> = {},
  extra: { jev?: Jev; now?: () => Date; sites?: SiteDeps } = {},
) {
  const mail = fakeMail();
  const calendar = fakeCalendar();
  const ramp = fakeRamp();
  const written: { userId: string; path: string; bytes: Uint8Array }[] = [];
  const app = createVmApi({
    db: tx,
    runTokenSecret: testSecret,
    jev: extra.jev,
    sites: extra.sites,
    // Fixtures are dated late September 2026: free time is looked for from here.
    now: extra.now ?? (() => new Date("2026-09-28T12:00:00Z")),
    connectors: {
      webPublicUrl: "https://runwinston.com",
      mail: () => mail.provider,
      calendar: () => calendar.reader,
      ramp: () => ramp.provider,
    },
    vmFiles: {
      read: (_userId, path) => {
        const contents = vmFileContents[path];
        return contents === undefined
          ? Promise.reject(new Error(`No file ${path}`))
          : Promise.resolve(
              typeof contents === "string"
                ? new TextEncoder().encode(contents)
                : contents,
            );
      },
      write: (userId, path, bytes) => {
        written.push({ userId, path, bytes });
        return Promise.resolve({ size: bytes.length });
      },
    },
  });
  const as = (
    userId: string,
    runId = "run_1",
    kind: "front" | "background" = "front",
  ) => {
    const token = mintRunToken(testSecret, { runId, userId, kind }, 60_000);
    return (path: string, init: { method?: string; body?: unknown } = {}) =>
      app.request(
        path,
        {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        },
        { vmUserId: userId },
      );
  };
  return { as, mail, calendar, ramp, written };
}
