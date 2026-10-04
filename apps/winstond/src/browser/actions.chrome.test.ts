/**
 * Browser actions against a real Chrome. Runs only when one is given:
 * WINSTON_TEST_CHROME is its DevTools HTTP address, WINSTON_TEST_PAGES where
 * that Chrome can load the pages in fixtures/ (docs/design.md §11 has how
 * to run one in the local VM). Skipped otherwise, as in CI.
 */
import { describe, expect, test } from "bun:test";
import { connectCdp } from "./cdp.ts";
import { BrowserFailure, createBrowser } from "./windows.ts";

const devtools = process.env.WINSTON_TEST_CHROME;
const pages = process.env.WINSTON_TEST_PAGES;
const run = devtools && pages ? test : test.skip;
/** Where that Chrome sees fixtures/ on its own disk, for uploads (default: here). */
const fixtures =
  process.env.WINSTON_TEST_FIXTURES ?? `${import.meta.dir}/fixtures`;

const token = `${Buffer.from(JSON.stringify({ runId: "run_test", userId: "usr_1", kind: "background", exp: Date.now() + 3_600_000 })).toString("base64url")}.sig`;

const saved = new Map<string, Uint8Array>();
const browser = createBrowser({
  saveFile: (path, bytes) => {
    saved.set(path, bytes);
    return Promise.resolve();
  },
  // Paths are the test's own, already where Chrome can read them.
  findFile: (path) => Promise.resolve(path),
  connect: async () => {
    const version = (await (
      await fetch(`${devtools ?? ""}/json/version`)
    ).json()) as {
      webSocketDebuggerUrl: string;
    };
    // The address Chrome reports is its own; reach it the way we reached it.
    const url = new URL(version.webSocketDebuggerUrl);
    const via = new URL(devtools ?? "");
    url.host = via.host;
    return connectCdp(url.href);
  },
});

/** Where an element shows, for a click at a point: scrolled into view first. */
async function centerOf(selector: string) {
  const { value } = await browser.eval(token, {
    code: `const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`,
  });
  return JSON.parse(value) as { x: number; y: number };
}

/** A click at an element's middle, the way a coordinate click goes. */
async function clickAt(selector: string) {
  const { x, y } = await centerOf(selector);
  return browser.clickXY(token, x, y);
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrowserFailure) return error;
    throw error;
  }
  throw new Error("expected a BrowserFailure");
};

describe("browser actions in Chrome", () => {
  run(
    "a click at a point waits for the page to settle; wait finds what comes later",
    async () => {
      await browser.open(token, `${pages ?? ""}/actions.html`);
      const result = await clickAt("#later");
      expect(result.settled).toBe(true);
      await browser.wait(token, { text: "Loaded later", timeoutMs: 5_000 });
      const late = await failure(
        browser.wait(token, { text: "Never here", timeoutMs: 500 }),
      );
      expect(late.message).toStartWith('"Never here" didn\'t appear');
    },
    30_000,
  );

  run(
    "a confirm waits for an answer and blocks other actions; an alert is answered",
    async () => {
      const asked = await clickAt("#delete");
      expect(asked.dialog).toMatchObject({
        type: "confirm",
        message: "Delete it?",
      });
      const blocked = await failure(browser.clickXY(token, 5, 5));
      expect(blocked.hint).toBe(
        "Answer it with winston browser dialog accept (or dismiss).",
      );
      const answered = await browser.dialog(token, { accept: false });
      expect(answered.did).toBe('Dismissed the confirm: "Delete it?".');
      await browser.wait(token, { text: "Kept", timeoutMs: 3_000 });
      const alerted = await clickAt("#alert");
      expect(alerted.handledDialogs).toEqual([
        'The page showed an alert: "Hello there" (dismissed).',
      ]);
    },
    30_000,
  );

  run(
    "a link that opens a window joins the run",
    async () => {
      const popup = await clickAt("a");
      expect(popup.opened).toHaveLength(1);
      expect(popup.opened[0]?.url).toEndWith("/pay.html");
      await browser.close(token);
    },
    30_000,
  );

  run(
    "a screenshot is a PNG of the viewport or the whole page; eval runs apart from the page unless asked",
    async () => {
      await browser.open(token, `${pages ?? ""}/actions.html`);
      const shot = await browser.screenshot(token, {});
      const png = saved.get(shot.path.replace("/home/winston/", ""));
      expect(
        Buffer.from(png ?? [])
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      const full = await browser.screenshot(token, { fullPage: true });
      expect(full.height).toBeGreaterThan(shot.height);
      expect(
        (await browser.eval(token, { code: "document.title" })).value,
      ).toBe('"Actions"');
      expect(
        (
          await browser.eval(token, {
            code: "const links = [...document.links]; return links.length",
          })
        ).value,
      ).toBe("1");
      // The page's own variables are only in its world.
      expect(
        (await browser.eval(token, { code: "window.appState" })).value,
      ).toBe("undefined");
      expect(
        (
          await browser.eval(token, {
            code: "window.appState",
            pageWorld: true,
          })
        ).value,
      ).toBe('{\n  "cart": 3\n}');
      const thrown = await failure(browser.eval(token, { code: "nope()" }));
      expect(thrown.message).toBe(
        "The script threw: ReferenceError: nope is not defined",
      );
      await browser.close(token);
    },
    30_000,
  );

  run(
    "a page asking for files never opens Chrome's picker; upload fills the input it asked with, in a frame too",
    async () => {
      await browser.open(token, `${pages ?? ""}/upload.html`);
      // Any file Chrome can read will do: the fixture itself.
      const file = `${fixtures}/upload.html`;
      const frameFile = `${fixtures}/upload-frame.html`;

      expect((await clickAt("#one")).fileChooser).toEqual({ multiple: false });
      expect((await browser.upload(token, [file])).fileChooser).toBeNull();
      await browser.wait(token, { text: "one: upload.html", timeoutMs: 3_000 });

      expect((await clickAt("#many")).fileChooser).toEqual({ multiple: true });
      await browser.upload(token, [file, frameFile]);
      await browser.wait(token, {
        text: "many: upload.html, upload-frame.html",
        timeoutMs: 3_000,
      });

      // A script's own input, clicked from the button's handler.
      expect((await clickAt("#drive")).fileChooser).toEqual({ multiple: true });
      await browser.upload(token, [frameFile]);
      await browser.wait(token, {
        text: "drive: upload-frame.html",
        timeoutMs: 3_000,
      });

      // The cross-site frame's input sits at its top left.
      await browser.wait(token, { timeoutMs: 5_000 });
      const { value } = await browser.eval(token, {
        code: `const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.x + 20, y: r.y + 10 }`,
      });
      const at = JSON.parse(value) as { x: number; y: number };
      expect((await browser.clickXY(token, at.x, at.y)).fileChooser).toEqual({
        multiple: false,
      });
      await browser.upload(token, [file]);
      await browser.wait(token, {
        text: "frame: upload.html",
        timeoutMs: 3_000,
      });
      await browser.close(token);
    },
    30_000,
  );
});

// Pages are data: URLs here, so only a Chrome is needed; it must reach this
// process at 127.0.0.1 (a local Chrome, not one in the VM image).
const runLocal = devtools ? test : test.skip;

describe("settling in Chrome", () => {
  runLocal(
    "a frame that never finishes loading doesn't hold an action up",
    async () => {
      // A widget's frame whose server never answers: it stays loading.
      const hang = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Promise<Response>(() => undefined),
      });
      try {
        await browser.open(
          token,
          `data:text/html,${encodeURIComponent(
            `<!doctype html><title>Widget</title><button onclick="this.textContent='Clicked'">Go</button><iframe src="http://127.0.0.1:${String(hang.port)}/widget"></iframe>`,
          )}`,
        );
        const started = Date.now();
        const clicked = await clickAt("button");
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(clicked.settled).toBe(true);
        await browser.wait(token, { text: "Clicked", timeoutMs: 1_000 });
        await browser.close(token);
      } finally {
        await hang.stop(true);
      }
    },
    60_000,
  );
});
