import { describe, expect, test } from "bun:test";
import {
  apiError,
  apiErrors,
  type ApiErrorCode,
} from "@winston/domain/api-errors";
import { apiClient, localClient } from "./client.ts";
import { run, type Io } from "./cli.ts";
import { parseFlags, resolveText, standardFlags } from "./flags.ts";
import { json, list } from "./output.ts";

const me = {
  id: "usr_1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  timezone: "Europe/London",
};

/** Runs the CLI against a fake backend; returns the exit code and what was printed. */
async function cli(
  argv: string[],
  backend: (request: Request) => Response | Promise<Response> = () =>
    Response.json(me),
) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: Request[] = [];
  const socket = {
    socketPath: "/unused",
    runToken: "run-token",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const request = new Request(url, init);
      requests.push(request);
      return backend(request);
    },
  };
  const io: Io = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    text: {
      readStdin: () => Promise.resolve("from stdin"),
      readFile: () => Promise.resolve("from file"),
    },
    files: {
      home: "/home/winston",
      cwd: "/home/winston",
      exists: () => Promise.resolve(false),
    },
    client: () => apiClient(socket),
    local: () => localClient(socket),
  };
  const code = await run(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n"), requests };
}

describe("flags", () => {
  const specs = [
    standardFlags.limit,
    standardFlags.since,
    { name: "from", value: "<address>", description: "Sender" },
  ];

  test("values, = values, switches, integers and positionals", () => {
    expect(
      parseFlags(["msg_1", "--limit", "5", "--since=2h", "--json"], specs),
    ).toEqual({
      positionals: ["msg_1"],
      flags: { limit: 5, since: "2h", json: true },
    });
  });

  test("an unknown flag suggests the closest one, as §11 words it", () => {
    expect(() => parseFlags(["--form", "a@b.com"], specs)).toThrow(
      "Unknown flag `--form`. Did you mean `--from`?",
    );
    expect(() => parseFlags(["--zzzzzz"], specs)).toThrow(
      "Unknown flag `--zzzzzz`.",
    );
  });

  test("missing values and non-integers are usage errors", () => {
    expect(() => parseFlags(["--limit"], specs)).toThrow(
      "`--limit` needs a value",
    );
    expect(() => parseFlags(["--limit", "--json"], specs)).toThrow(
      "`--limit` needs a value",
    );
    expect(() => parseFlags(["--limit", "five"], specs)).toThrow(
      "must be a whole number",
    );
    expect(() => parseFlags(["--json=yes"], specs)).toThrow(
      "doesn't take a value",
    );
  });

  test("long text comes as a literal, from stdin with -, or from a file with @path", async () => {
    const sources = {
      readStdin: () => Promise.resolve("piped"),
      readFile: (path: string) => Promise.resolve(`contents of ${path}`),
    };
    expect(await resolveText("hello", sources)).toBe("hello");
    expect(await resolveText("-", sources)).toBe("piped");
    expect(await resolveText("@notes/draft.md", sources)).toBe(
      "contents of notes/draft.md",
    );
    const failing = {
      ...sources,
      readFile: () => Promise.reject(new Error("nope")),
    };
    expect(resolveText("@missing.md", failing)).rejects.toThrow(
      "Couldn't read missing.md.",
    );
  });
});

describe("output", () => {
  test("lists are bounded, with a footer that says how to get more", () => {
    const lines = Array.from(
      { length: 25 },
      (_, i) => `msg_${String(i)} · subject ${String(i)}`,
    );
    const text = list(lines, {
      limit: 20,
      nextCursor: "c_8f2",
      narrow: "--since",
    });
    expect(text.split("\n")).toHaveLength(21);
    expect(text.split("\n").at(-1)).toBe(
      "… 5 more. To see them, use --cursor c_8f2 or narrow with --since.",
    );
    expect(list([])).toBe("Nothing found.");
    expect(list(["a"], { limit: 20 })).toBe("a");
  });

  test("JSON is deterministic: sorted keys", () => {
    expect(json({ b: 1, a: { d: 2, c: 3 } })).toBe(
      json({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

describe("winston", () => {
  test("with no arguments, lists the resources", async () => {
    const { code, out } = await cli([]);
    expect(code).toBe(0);
    expect(out).toContain("Usage: winston <resource> <verb> [<id>] [--flags]");
    expect(out).toMatch(/me\s+The user you work for/);
  });

  test("resource help shows verbs and real examples; verb help shows flags", async () => {
    expect((await cli(["me", "--help"])).out).toContain(
      "winston me update --timezone Europe/London",
    );
    const verb = await cli(["me", "update", "--help"]);
    expect(verb.out).toContain("--timezone <iana>");
    expect(verb.out).toContain("--json");
  });

  test("unknown resources and verbs suggest the closest match and exit 1", async () => {
    const resource = await cli(["mee", "get"]);
    expect(resource.code).toBe(1);
    expect(resource.err).toContain("Did you mean `me`?");
    const verb = await cli(["me", "gte"]);
    expect(verb.code).toBe(1);
    expect(verb.err).toContain("Did you mean `get`?");
  });

  test("me get prints one record; --json prints the object; the run token travels along", async () => {
    const text = await cli(["me", "get"]);
    expect(text.out).toBe(
      "usr_1 · Ada Lovelace · ada@example.com · Europe/London",
    );
    expect(text.requests[0]?.headers.get("Authorization")).toBe(
      "Bearer run-token",
    );
    expect(JSON.parse((await cli(["me", "get", "--json"])).out)).toEqual(me);
  });

  test("me update sends the time zone", async () => {
    const { out, requests } = await cli([
      "me",
      "update",
      "--timezone",
      "Europe/London",
    ]);
    expect(requests[0]?.method).toBe("PATCH");
    expect(await requests[0]?.json()).toEqual({ timezone: "Europe/London" });
    expect(out).toContain("Europe/London");
  });

  test("every backend error code maps to its exit code, with the message and hint", async () => {
    for (const code of Object.keys(apiErrors) as ApiErrorCode[]) {
      const result = await cli(["me", "get"], () =>
        Response.json(apiError(code, `failed with ${code}`, "do this next"), {
          status: apiErrors[code].status,
        }),
      );
      expect(result.code).toBe(apiErrors[code].exitCode);
      expect(result.err).toBe(`failed with ${code}\ndo this next`);
    }
  });

  test("an unreachable winstond is a transient failure (exit 5)", async () => {
    const result = await cli(["me", "get"], () => {
      throw new Error("connect ENOENT /run/winstond/winstond.sock");
    });
    expect(result.code).toBe(5);
    expect(result.err).toContain("Can't reach winstond");
  });
});
