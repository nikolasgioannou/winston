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

const token = `${Buffer.from(JSON.stringify({ runId: "run_test", userId: "usr_1", kind: "background", exp: Date.now() + 3_600_000 })).toString("base64url")}.sig`;

const saved = new Map<string, Uint8Array>();
const browser = createBrowser({
  saveFile: (path, bytes) => {
    saved.set(path, bytes);
    return Promise.resolve();
  },
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

/** The ref of the first snapshot line matching `pattern`. */
async function refOf(pattern: RegExp) {
  const { lines } = await browser.snapshot(token, {});
  const line = lines.find((l) => pattern.test(l));
  const ref = line?.match(/\[(e\d+)\]/)?.[1];
  if (!ref)
    throw new Error(`no ref for ${String(pattern)} in:\n${lines.join("\n")}`);
  return ref;
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
    "type, click, select and press do what a person would",
    async () => {
      await browser.open(token, `${pages ?? ""}/actions.html`);
      await browser.type(token, await refOf(/textbox "Name"/), "Ada", {});
      await browser.click(token, await refOf(/button "Go"/));
      await browser.wait(token, { text: "Hello Ada", timeoutMs: 3_000 });
      await browser.type(token, await refOf(/textbox "Name"/), "Grace", {
        clear: true,
      });
      await browser.press(token, "Tab");
      await browser.click(token, await refOf(/button "Go"/));
      await browser.wait(token, { text: "Hello Grace", timeoutMs: 3_000 });
      const selected = await browser.select(
        token,
        await refOf(/combobox "Country"/),
        "cyprus",
      );
      expect(selected.did).toBe(
        'Selected "cyprus" in ' + (await refOf(/combobox "Country"/)) + ".",
      );
      await browser.wait(token, { text: "Country Cyprus", timeoutMs: 3_000 });
      const missing = await failure(
        browser.select(token, await refOf(/combobox "Country"/), "Mars"),
      );
      expect(missing.hint).toBe("Its options: Canada, Cyprus.");
    },
    60_000,
  );

  run(
    "an action waits for the page to settle; wait finds what comes later",
    async () => {
      const result = await browser.click(
        token,
        await refOf(/button "Load later"/),
      );
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
    "a covered element isn't clicked; once the banner goes, it is",
    async () => {
      const under = await refOf(/button "Under the banner"/);
      const covered = await failure(browser.click(token, under));
      expect(covered.message).toBe(
        `${under} (button "Under the banner") is covered by <div id="banner">.`,
      );
      await browser.click(token, await refOf(/button "Accept cookies"/));
      await browser.click(token, await refOf(/button "Under the banner"/));
      await browser.wait(token, { text: "Covered clicked", timeoutMs: 3_000 });
    },
    30_000,
  );

  run(
    "a confirm waits for an answer and blocks other actions; an alert is answered",
    async () => {
      const asked = await browser.click(token, await refOf(/button "Delete"/));
      expect(asked.dialog).toMatchObject({
        type: "confirm",
        message: "Delete it?",
      });
      const blocked = await failure(browser.press(token, "Tab"));
      expect(blocked.hint).toBe(
        "Answer it with winston browser dialog accept (or dismiss).",
      );
      const answered = await browser.dialog(token, { accept: false });
      expect(answered.did).toBe('Dismissed the confirm: "Delete it?".');
      await browser.wait(token, { text: "Kept", timeoutMs: 3_000 });
      const alerted = await browser.click(token, await refOf(/button "Alert"/));
      expect(alerted.handledDialogs).toEqual([
        'The page showed an alert: "Hello there" (dismissed).',
      ]);
    },
    30_000,
  );

  run(
    "scrolling reaches an element; a link opening a window joins the run",
    async () => {
      await browser.scroll(token, {
        to: await refOf(/button "At the bottom"/),
      });
      await browser.click(token, await refOf(/button "At the bottom"/));
      await browser.wait(token, { text: "Bottom clicked", timeoutMs: 3_000 });
      const popup = await browser.click(
        token,
        await refOf(/link "Open payment"/),
      );
      expect(popup.opened).toHaveLength(1);
      expect(popup.opened[0]?.url).toEndWith("/pay.html");
      await browser.close(token);
    },
    30_000,
  );

  run(
    "a ref from before the page changed fails and says to snapshot again",
    async () => {
      const stale = await refOf(/button "Go"/);
      await browser.navigate(token, { url: `${pages ?? ""}/form.html` });
      const refused = await failure(browser.click(token, stale));
      expect(refused.code).toBe("invalid_request");
      expect(refused.hint).toBe(
        "Refs change as the page does; take a new snapshot and use a ref from it.",
      );
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
});
