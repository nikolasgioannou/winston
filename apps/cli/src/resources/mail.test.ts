import { describe, expect, test } from "bun:test";
import {
  apiError,
  apiErrors,
  type ApiErrorCode,
} from "@winston/domain/api-errors";
import { apiClient } from "../client.ts";
import { run } from "../cli.ts";
import { bodyPreviewChars } from "./mail.ts";

const summary = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  threadId: "thr_01lease",
  date: "2026-09-25T20:02:00.000Z",
  from: { name: "Dana Reyes", email: "dana@example.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  subject: "Re: Lease renewal",
  snippet: "Tuesday works",
  unread: true,
  starred: false,
  inInbox: true,
  labels: [],
  attachmentCount: 0,
  ...overrides,
});

const page = {
  account: { id: "acct_1", email: "me@example.com" },
  timeZone: "America/New_York",
  messages: [
    summary("msg_01a", { attachmentCount: 1, labels: ["Lease stuff"] }),
    summary("msg_01b", {
      unread: false,
      inInbox: false,
      subject: "",
      from: null,
    }),
  ],
  cursor: "c_8f2",
  estimatedTotal: 30,
};

const detail = (body: string, kind: "message" | "thread" = "message") => ({
  account: { id: "acct_1", email: "me@example.com" },
  timeZone: "America/New_York",
  kind,
  messages: (kind === "thread" ? ["msg_01a", "msg_01b"] : ["msg_01a"]).map(
    (id) => ({
      ...summary(id),
      body,
      quotedTextHidden: kind === "message",
      replyTo: [],
      attachments:
        id === "msg_01a"
          ? [
              {
                id: "att_01pdf",
                filename: "lease.pdf",
                mimeType: "application/pdf",
                size: 81_234,
              },
            ]
          : [],
    }),
  ),
});

/** Runs the CLI against a fake backend; returns the exit code, output and requests. */
async function cli(
  argv: string[],
  backend: (request: Request) => Response | Promise<Response>,
  existing: string[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: Request[] = [];
  const code = await run(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    text: {
      readStdin: () => Promise.resolve(""),
      readFile: () => Promise.resolve(""),
    },
    files: {
      home: "/home/winston",
      cwd: "/home/winston/notes",
      exists: (path) => Promise.resolve(existing.includes(path)),
    },
    client: () =>
      apiClient({
        socketPath: "/unused",
        runToken: "run-token",
        fetch: async (input, init) => {
          const request = new Request(
            input instanceof Request ? input.url : String(input),
            init,
          );
          requests.push(request);
          return backend(new Request(request));
        },
      }),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), requests };
}

describe("winston mail", () => {
  test("list prints one line per message in the user's zone, with a footer naming the cursor", async () => {
    const { code, out, requests } = await cli(
      ["mail", "list", "--unread", "--since", "3d"],
      () => Response.json(page),
    );
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "msg_01a  2026-09-25 16:02 -04:00  Dana Reyes <dana@example.com>  Re: Lease renewal  [inbox, unread, Lease stuff, 📎]  thr_01lease",
        "msg_01b  2026-09-25 16:02 -04:00  (no sender)  (no subject)  thr_01lease",
        "… more. To see them, use --cursor c_8f2 or narrow with --since, --from or --unread.",
      ].join("\n"),
    );
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/mail/messages");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      in: "inbox",
      unread: "true",
      since: "3d",
    });
  });

  test("search looks everywhere by default and sends the words as text", async () => {
    const { requests } = await cli(
      [
        "mail",
        "search",
        "board",
        "deck",
        "--read",
        "--account",
        "work@acme.com",
      ],
      () => Response.json({ ...page, cursor: null }),
    );
    expect(
      Object.fromEntries(new URL(requests[0]?.url ?? "").searchParams),
    ).toEqual({
      in: "all",
      text: "board deck",
      unread: "false",
      account: "work@acme.com",
    });
  });

  test("get shows headers, attachments as att_ ids, and the body, noting hidden quotes", async () => {
    const { out, requests } = await cli(["mail", "get", "msg_01a"], () =>
      Response.json(detail("Tuesday works.")),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/mail/messages/msg_01a",
    );
    expect(out).toBe(
      [
        "msg_01a · thr_01lease",
        "From: Dana Reyes <dana@example.com>",
        "To: me@example.com",
        "Date: 2026-09-25 16:02 -04:00",
        "Subject: Re: Lease renewal",
        "Tags: inbox, unread",
        "Attachment: att_01pdf lease.pdf (application/pdf, 79 KB)",
        "",
        "Tuesday works.",
        "[Quoted earlier messages hidden.]",
      ].join("\n"),
    );
  });

  test("long bodies stop with a note on how to see the rest; --full shows it all; threads are numbered", async () => {
    const long = "x".repeat(bodyPreviewChars + 500);
    const { out } = await cli(["mail", "get", "msg_01a"], () =>
      Response.json(detail(long)),
    );
    expect(out).toContain("… 500 more characters. To see them, add --full.");
    const full = await cli(["mail", "get", "msg_01a", "--full"], () =>
      Response.json(detail(long)),
    );
    expect(full.out).not.toContain("more characters");
    const thread = await cli(["mail", "get", "thr_01lease"], () =>
      Response.json(detail("hi", "thread")),
    );
    expect(thread.out.split("\n")[0]).toBe(
      "thr_01lease · Re: Lease renewal · 2 messages, oldest first",
    );
    expect(thread.out).toContain("── 2/2 ──");
  });

  test("--json prints the API's own shape", async () => {
    const { out } = await cli(["mail", "list", "--json"], () =>
      Response.json(page),
    );
    expect(JSON.parse(out)).toEqual(page);
  });

  test("download saves under ~/downloads without overwriting, and prints the paths", async () => {
    const { out, requests } = await cli(
      ["mail", "download", "att_01pdf"],
      (request) =>
        request.method === "GET"
          ? Response.json({
              id: "att_01pdf",
              filename: "lease.pdf",
              mimeType: "application/pdf",
              size: 81_234,
            })
          : request.json().then((body) =>
              Response.json({
                id: "att_01pdf",
                path: (body as { path: string }).path,
                size: 81_234,
              }),
            ),
      ["/home/winston/downloads/lease.pdf"],
    );
    expect(out).toBe(
      "att_01pdf  /home/winston/downloads/lease (2).pdf  (79 KB)",
    );
    expect(await requests[1]?.json()).toEqual({
      path: "/home/winston/downloads/lease (2).pdf",
    });
  });

  test("download --to resolves relative paths and refuses ones outside home", async () => {
    const backend = (request: Request) =>
      request.method === "GET"
        ? Response.json({
            id: "att_1",
            filename: "../../etc/x.pdf",
            mimeType: "application/pdf",
            size: 1,
          })
        : request.json().then((body) =>
            Response.json({
              id: "att_1",
              path: (body as { path: string }).path,
              size: 1,
            }),
          );
    const inside = await cli(
      ["mail", "download", "att_1", "--to", "lease"],
      backend,
    );
    expect(inside.out).toBe("att_1  /home/winston/notes/lease/x.pdf  (1 B)");
    const outside = await cli(
      ["mail", "download", "att_1", "--to", "/etc"],
      backend,
    );
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("/etc is outside /home/winston.");
  });

  test("no account, ambiguity, reading off and expired grants exit with their codes and hints", async () => {
    const cases: [ApiErrorCode, number][] = [
      ["not_found", 2],
      ["invalid_request", 1],
      ["permission_disabled", 3],
      ["auth_expired", 4],
      ["unavailable", 5],
    ];
    for (const [code, exit] of cases) {
      const result = await cli(["mail", "list"], () =>
        Response.json(apiError(code, `A ${code} message.`, `A ${code} hint.`), {
          status: apiErrors[code].status,
        }),
      );
      expect(result.code).toBe(exit);
      expect(result.err).toBe(`A ${code} message.\nA ${code} hint.`);
    }
  });

  test("usage errors: get without an id, both --read and --unread", async () => {
    expect((await cli(["mail", "get"], () => Response.json({}))).code).toBe(1);
    expect(
      (
        await cli(["mail", "list", "--read", "--unread"], () =>
          Response.json(page),
        )
      ).code,
    ).toBe(1);
  });
});
