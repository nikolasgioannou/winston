/**
 * Autopilot's page reader against a real Chrome, ported from jev-ultrafast's
 * `scripts/check_guards.py`, plus the closed-shadow-root click. Runs only
 * when WINSTON_TEST_CHROME gives a DevTools HTTP address (pages are data:
 * URLs, so nothing needs serving); skipped otherwise, as in CI.
 */
import { describe, expect, test } from "bun:test";
import { connectCdp } from "./cdp.ts";
import { fastPage, StalePage, type FastPage } from "./fast-page.ts";
import { createBrowser } from "./windows.ts";

const devtools = process.env.WINSTON_TEST_CHROME;
const run = devtools ? test : test.skip;

const token = `${Buffer.from(JSON.stringify({ runId: "run_fast", userId: "usr_1", kind: "background", exp: Date.now() + 3_600_000 })).toString("base64url")}.sig`;

const browser = createBrowser({
  connect: async () => {
    const version = (await (
      await fetch(`${devtools ?? ""}/json/version`)
    ).json()) as { webSocketDebuggerUrl: string };
    const url = new URL(version.webSocketDebuggerUrl);
    url.host = new URL(devtools ?? "").host;
    return connectCdp(url.href);
  },
});
const core = browser.autopilotCore;
const reader = fastPage({ sessionFor: (entry) => core.sessionFor(entry) });
const entry = () => core.windowFor(core.caller(token), undefined, "own");

/** Runs script among the page's own scripts, for its globals and handlers. */
const inPage = async (code: string) => {
  const { value } = await browser.eval(token, { code, pageWorld: true });
  return value === "undefined" ? undefined : (JSON.parse(value) as unknown);
};

const html = (body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>Checks</title>${body}`)}`;

const guards =
  html(`<style>body{margin:30px}button{width:180px;height:50px}#outside{position:absolute;top:3000px}</style>
<p id="context">Cart total: $10</p>
<button id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
<label>City<input id="field" value="Zurich"></label>
<label><input id="toggle" type="checkbox">Refundable</label>
<select aria-label="Category"><option>All</option><option>Design</option></select>
<p id="outside">Unrelated offscreen text</p>`);

const labelled = (page: FastPage, label: string) => {
  const action = page.actions.find((a) => a.label === label);
  if (!action)
    throw new Error(`no ${label} in ${JSON.stringify(page.actions)}`);
  return action;
};

describe("autopilot's page reader in Chrome", () => {
  run(
    "geometry is read again before input; meaning changes invalidate; an overlay blocks the click",
    async () => {
      await browser.open(token, guards);
      let page = await reader.observe(entry());
      await inPage(
        "document.querySelector('#target').style.transform='translateX(200px)'",
      );
      expect(await reader.fresh(entry(), page)).toBe(true);
      await reader.act(entry(), page, labelled(page, "Continue"));
      expect(await inPage("window.clicks")).toBe(1);

      await inPage(
        "document.querySelector('#outside').textContent='Updated outside the viewport'",
      );
      expect(await reader.fresh(entry(), page)).toBe(true);

      const mutations = {
        "visible context":
          "document.querySelector('#context').textContent='Cart total: $100'",
        "accessible label":
          "document.querySelector('#target').setAttribute('aria-label','Delete account')",
        "field property": "document.querySelector('#field').value='London'",
        "checkbox property": "document.querySelector('#toggle').checked=true",
        "disabled target": "document.querySelector('#target').disabled=true",
        "read-only field": "document.querySelector('#field').readOnly=true",
        "hidden target":
          "document.querySelector('#target').style.display='none'",
        "replaced node":
          "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
        "dropdown option":
          "document.querySelector('select').options[1].text='Coastal'",
      };
      for (const [label, expression] of Object.entries(mutations)) {
        await inPage(
          "document.querySelector('#target').style.display='block'; document.querySelector('#target').disabled=false",
        );
        page = await reader.observe(entry());
        await inPage(expression);
        expect([label, await reader.fresh(entry(), page)]).toEqual([
          label,
          false,
        ]);
      }

      await inPage(
        "document.querySelector('#target').disabled=false; document.querySelector('#target').style.display='block'",
      );
      page = await reader.observe(entry());
      const target = labelled(page, "Delete account");
      // A textless overlay doesn't change the meaning, but must block the click.
      await inPage(
        "const cover=document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover)",
      );
      expect(await reader.fresh(entry(), page)).toBe(true);
      expect(
        await reader.act(entry(), page, target).catch((e: unknown) => e),
      ).toBeInstanceOf(StalePage);
      expect(await inPage("window.clicks")).toBe(1);
    },
    30_000,
  );

  run(
    "a click's own guard ignores unrelated updates; native controls offer only what they support",
    async () => {
      await browser.open(
        token,
        html(`<form><p id="price">Total $10</p>
          <button type="button" id="buy">Buy</button>
          <label>Search <input id="query" role="combobox" aria-controls="suggestions"></label>
          <div role="listbox" id="suggestions"></div>
          <label><input id="check" type="checkbox">Enabled</label>
          <label><input id="radio" type="radio">Choice</label>
          <input id="readonly" aria-label="Read only" readonly>
          <input id="secret" type="password" value="never expose this">
          <button id="off" disabled>Disabled</button>
          <select id="category" aria-label="Category">
            <option>All</option><option>Design</option><option disabled>Unavailable</option>
          </select></form><aside id="unrelated">News</aside>`),
      );
      let page = await reader.observe(entry());
      await inPage(
        "document.querySelector('#unrelated').textContent='New unrelated news'",
      );
      expect(await reader.fresh(entry(), page, labelled(page, "Buy"))).toBe(
        true,
      );
      expect(await reader.fresh(entry(), page)).toBe(false);
      for (const [label, expression] of Object.entries({
        "nearby price":
          "document.querySelector('#price').textContent='Total $100'",
        "form value": "document.querySelector('#query').value='changed'",
        "form toggle": "document.querySelector('#check').checked=true",
        "target replacement":
          "document.querySelector('#buy').outerHTML=document.querySelector('#buy').outerHTML",
      })) {
        page = await reader.observe(entry());
        const buy = labelled(page, "Buy");
        await inPage(expression);
        expect([label, await reader.fresh(entry(), page, buy)]).toEqual([
          label,
          false,
        ]);
      }

      page = await reader.observe(entry());
      const kinds = (role: string) =>
        new Set(page.actions.filter((a) => a.role === role).map((a) => a.kind));
      expect(kinds("checkbox")).toEqual(new Set(["click"]));
      expect(kinds("radio")).toEqual(new Set(["click"]));
      expect(
        new Set(
          page.actions
            .filter((a) => a.label === "Read only")
            .map((a) => a.kind),
        ),
      ).toEqual(new Set(["click"]));
      expect(
        page.actions.some(
          (a) => a.label === "Disabled" || a.value === "never expose this",
        ),
      ).toBe(false);
      expect(
        page.actions.filter((a) => a.kind === "select").map((a) => a.value),
      ).toEqual(["Design"]);

      await reader.act(
        entry(),
        page,
        page.actions.find((a) => a.kind === "select") ?? labelled(page, "x"),
      );
      expect(await inPage("document.querySelector('#category').value")).toBe(
        "Design",
      );

      await inPage(
        "document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'},60))",
      );
      page = await reader.observe(entry());
      const field = page.actions.find((a) => a.kind === "fill");
      if (!field) throw new Error("no field");
      await reader.act(entry(), page, field, "Generated");
      await reader.settle(entry(), field);
      page = await reader.observe(entry());
      expect(await inPage("document.querySelector('#query').value")).toBe(
        "Generated",
      );
      expect(page.actions.some((a) => a.role === "option")).toBe(true);
      // Typing replaces what was there.
      await reader.act(
        entry(),
        page,
        page.actions.find((a) => a.kind === "fill") ?? field,
        "Again",
      );
      expect(await inPage("document.querySelector('#query').value")).toBe(
        "Again",
      );
    },
    30_000,
  );

  run(
    "open shadow roots are read; nothing of ours is left where the page can see it",
    async () => {
      await browser.open(
        token,
        html(`<x-box></x-box><script>
          customElements.define('x-box', class extends HTMLElement {
            constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML =
              '<p>Inside the shadow</p><button onclick="window.top.shadowClicks=(window.top.shadowClicks||0)+1">Shadow button</button>'; }
          });</script>`),
      );
      const page = await reader.observe(entry());
      expect(page.text).toContain("Inside the shadow");
      await reader.act(entry(), page, labelled(page, "Shadow button"));
      expect(await inPage("window.shadowClicks")).toBe(1);
      expect(await inPage("typeof window.__winstonFast")).toBe("undefined");
    },
    30_000,
  );

  run(
    "a button inside a closed shadow root isn't taken for covered by its host",
    async () => {
      await browser.open(
        token,
        html(`<ba-link></ba-link><script>
          customElements.define('ba-link', class extends HTMLElement {
            constructor() { super(); const root = this.attachShadow({ mode: 'closed' });
              root.innerHTML = '<button style="width:200px;height:40px">Continue to check-in</button>';
              root.querySelector('button').addEventListener('click', () => { window.closedClicks = (window.closedClicks||0)+1; }); }
          });</script>`),
      );
      const { lines } = await browser.snapshot(token, {});
      const ref = lines
        .find((l) => l.includes("Continue to check-in"))
        ?.match(/\[(e\d+)\]/)?.[1];
      if (!ref) throw new Error(`no ref in:\n${lines.join("\n")}`);
      await browser.click(token, ref);
      expect(await inPage("window.closedClicks")).toBe(1);
    },
    30_000,
  );
});
