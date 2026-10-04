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
        "document.querySelector('#target').style.transform='translateX(-25px)'",
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
      // A textless overlay covers every control: they're no longer offered,
      // and a click decided before it came is refused.
      await inPage(
        "const cover=document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover)",
      );
      expect(await reader.fresh(entry(), page)).toBe(false);
      expect(
        await reader.act(entry(), page, target).catch((e: unknown) => e),
      ).toBeInstanceOf(StalePage);
      expect(await inPage("window.clicks")).toBe(1);
      const covered = await reader.observe(entry());
      expect(covered.actions.filter((a) => a.node !== undefined)).toEqual([]);
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
      await reader.settle(entry(), page, field);
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
});

describe("keys in Chrome", () => {
  run(
    "Enter is offered in a focused field and submits it; Escape is offered while a menu is open, and closes it",
    async () => {
      await browser.open(
        token,
        html(`<form onsubmit="event.preventDefault(); document.querySelector('#out').textContent='Searched '+document.querySelector('#q').value"><input id="q" aria-label="Search"></form><p id="out"></p>
<button id="menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.querySelector('#list').hidden=false">Menu</button>
<ul id="list" role="menu" hidden><li role="menuitem">One</li></ul>
<script>document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.querySelector('#menu').setAttribute('aria-expanded','false'); document.querySelector('#list').hidden = true; } })</script>`),
      );
      let page = await reader.observe(entry());
      expect(page.actions.some((a) => a.kind === "key")).toBe(false);
      const field = page.actions.find((a) => a.kind === "fill");
      if (!field) throw new Error("no field");
      await reader.act(entry(), page, field, "dune");
      page = await reader.observe(entry());
      const enter = page.actions.find((a) => a.id === "press_enter");
      if (!enter)
        throw new Error(`no Enter in ${JSON.stringify(page.actions)}`);
      expect(enter.label).toBe("Press Enter in Search");
      await reader.act(entry(), page, enter);
      await Bun.sleep(50);
      expect(await inPage("document.querySelector('#out').textContent")).toBe(
        "Searched dune",
      );

      page = await reader.observe(entry());
      await reader.act(entry(), page, labelled(page, "Menu"));
      page = await reader.observe(entry());
      const escape = page.actions.find((a) => a.id === "press_escape");
      if (!escape)
        throw new Error(`no Escape in ${JSON.stringify(page.actions)}`);
      await reader.act(entry(), page, escape);
      expect(await inPage("document.querySelector('#list').hidden")).toBe(true);
    },
    30_000,
  );
});

describe("autopilot's page reader in frames", () => {
  run(
    "controls in a same-site and a cross-site frame are read, clicked, filled and selected where they are",
    async () => {
      // Two sites from one server: 127.0.0.1 hosts the page and a same-site
      // frame; localhost is another site, so its frame gets its own renderer.
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const page = (body: string) =>
            new Response(`<!doctype html>${body}`, {
              headers: { "Content-Type": "text/html" },
            });
          const { pathname, port } = new URL(request.url);
          if (pathname === "/inner")
            return page(
              `<title>Inner</title><button onclick="document.body.dataset.clicked='yes'">Inner button</button><label>Name<input id="name"></label>`,
            );
          if (pathname === "/widget")
            return page(
              `<title>Widget</title><style>body{margin:8px}</style><label>Party size<select id="size"><option>2</option><option>4</option></select></label><label>Notes<input id="notes"></label><button onclick="document.querySelector('#out').textContent='Booked for '+document.querySelector('#size').value+': '+document.querySelector('#notes').value">Find a table</button><p id="out"></p>`,
            );
          return page(
            `<title>Host</title><style>body{margin:20px}iframe{display:block;margin:10px 0 0 30px}</style><button onclick="window.topClicks=(window.topClicks||0)+1">Top button</button><iframe id="same" src="/inner" style="width:420px;height:160px;border:0"></iframe><iframe id="cross" src="http://localhost:${port}/widget" style="width:420px;height:200px;border:6px solid #333;padding:4px"></iframe>`,
          );
        },
      });
      try {
        await browser.open(token, `http://127.0.0.1:${String(server.port)}/`);
        let page = await reader.observe(entry());
        for (let i = 0; i < 50 && page.framed.length < 2; i += 1) {
          await Bun.sleep(100);
          page = await reader.observe(entry());
        }
        expect(entry().frames.size).toBe(1);
        expect(page.framed.map((f) => f.name).sort()).toEqual([
          "Inner",
          "Widget",
        ]);
        expect(page.frames).toBe(0);
        expect(page.text).toContain("[In a frame: Widget]");
        const inFrame = (label: string) => {
          const action = labelled(page, label);
          expect(action.frame).toBeDefined();
          return action;
        };

        await reader.act(entry(), page, inFrame("Inner button"));
        expect(
          await inPage(
            "document.querySelector('#same').contentDocument.body.dataset.clicked",
          ),
        ).toBe("yes");
        page = await reader.observe(entry());
        await reader.act(
          entry(),
          page,
          page.actions.find((a) => a.kind === "fill" && a.label === "Name") ??
            inFrame("Name"),
          "Ada",
        );
        expect(
          await inPage(
            "document.querySelector('#same').contentDocument.querySelector('#name').value",
          ),
        ).toBe("Ada");

        page = await reader.observe(entry());
        await reader.act(entry(), page, inFrame("Party size → 4"));
        page = await reader.observe(entry());
        await reader.act(
          entry(),
          page,
          page.actions.find((a) => a.kind === "fill" && a.label === "Notes") ??
            inFrame("Notes"),
          "window seat",
        );
        page = await reader.observe(entry());
        await reader.act(entry(), page, inFrame("Find a table"));
        await Bun.sleep(100);
        page = await reader.observe(entry());
        expect(page.text).toContain("Booked for 4: window seat");
        // The page itself still works alongside its frames.
        await reader.act(entry(), page, labelled(page, "Top button"));
        expect(await inPage("window.topClicks")).toBe(1);
        await browser.close(token);
      } finally {
        await server.stop(true);
      }
    },
    60_000,
  );
});
