import { describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { importSitePassKey, type SitePass } from "@winston/site-host/pass";
import {
  signSitePass,
  sitePassPublicKey,
  sitePassSigningKey,
} from "@winston/site-host/pass-sign";
import type { SiteRoute } from "@winston/site-host/route";
import { dispatch, siteLimits, type DispatchDeps } from "./handler.ts";

const route: SiteRoute = {
  script: "site_1",
  ownerId: "usr_owner",
  access: "private",
  paused: false,
};

const signingKey = sitePassSigningKey(randomBytes(32).toString("hex"));
const passKey = await importSitePassKey(sitePassPublicKey(signingKey));
const nonce = "a".repeat(32);
const passToken = (overrides: Partial<SitePass> = {}) =>
  signSitePass(
    {
      sub: "usr_owner",
      site: "blog",
      nonce,
      exp: Date.now() + 60_000,
      ...overrides,
    },
    signingKey,
  );

const deps = (overrides: Partial<DispatchDeps> = {}): DispatchDeps => ({
  domain: "runwinston.app",
  webUrl: "https://runwinston.com",
  passKey,
  route: (name) => Promise.resolve(name === "blog" ? route : null),
  site: () => Promise.resolve(new Response("the site")),
  ...overrides,
});

const get = (
  url: string,
  init: RequestInit & { cookie?: string } = {},
  overrides?: Partial<DispatchDeps>,
) =>
  dispatch(
    new Request(url, {
      ...init,
      headers: init.cookie ? { cookie: init.cookie } : {},
    }),
    deps(overrides),
  );

const ownerCookie = () => `__Host-winston_site_pass=${passToken()}`;

const setCookies = (response: Response) => response.headers.getSetCookie();

describe("dispatch", () => {
  test("the owner's pass reaches the site's Worker, with the limits and without the access cookies", async () => {
    const site = mock(() => Promise.resolve(new Response("the site")));
    const response = await get(
      "https://blog.runwinston.app/a?b=1",
      { cookie: `theme=dark; ${ownerCookie()}` },
      { site },
    );
    expect(await response.text()).toBe("the site");
    const [script, request, limits] = site.mock.calls[0] as unknown as [
      string,
      Request,
      unknown,
    ];
    expect(script).toBe("site_1");
    expect(request.url).toBe("https://blog.runwinston.app/a?b=1");
    expect(request.headers.get("cookie")).toBe("theme=dark");
    expect(limits).toEqual(siteLimits);
  });

  test("unknown names, the bare domain and malformed routes have no site", async () => {
    expect((await get("https://other.runwinston.app/")).status).toBe(404);
    expect((await get("https://runwinston.app/")).status).toBe(404);
    const malformed = await get(
      "https://blog.runwinston.app/",
      {},
      { route: () => Promise.resolve({ script: 1 }) },
    );
    expect(malformed.status).toBe(404);
    const missingWorker = await get(
      "https://blog.runwinston.app/",
      { cookie: ownerCookie() },
      { site: () => null },
    );
    expect(missingWorker.status).toBe(404);
  });

  test("a paused site shows the paused page, even to its owner", async () => {
    const response = await get(
      "https://blog.runwinston.app/",
      { cookie: ownerCookie() },
      { route: () => Promise.resolve({ ...route, paused: true }) },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("paused");
  });

  test("a page load without a pass goes to sign in, with a nonce cookie", async () => {
    const response = await get("https://blog.runwinston.app/notes?x=1");
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://runwinston.com/sites/open",
    );
    expect(location.searchParams.get("site")).toBe("blog");
    expect(location.searchParams.get("path")).toBe("/notes?x=1");
    const sentNonce = location.searchParams.get("nonce") ?? "";
    expect(sentNonce).toMatch(/^[0-9a-f]{32}$/);
    const [cookie] = setCookies(response);
    expect(cookie).toStartWith(`__Host-winston_site_nonce=${sentNonce};`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  test("other requests without a pass get the private page", async () => {
    const response = await get("https://blog.runwinston.app/api", {
      method: "POST",
    });
    expect(response.status).toBe(403);
  });

  test("someone else's pass gets the private page, without another sign-in", async () => {
    const site = mock(() => Promise.resolve(new Response("the site")));
    const response = await get(
      "https://blog.runwinston.app/",
      { cookie: `__Host-winston_site_pass=${passToken({ sub: "usr_other" })}` },
      { site },
    );
    expect(response.status).toBe(403);
    expect(site).not.toHaveBeenCalled();
  });

  test("a pass for another site doesn't count", async () => {
    const response = await get("https://blog.runwinston.app/", {
      cookie: `__Host-winston_site_pass=${passToken({ site: "other" })}`,
    });
    expect(response.status).toBe(303);
  });

  test("coming back with the owner's pass and this browser's nonce keeps the pass", async () => {
    const token = passToken();
    const response = await get(
      `https://blog.runwinston.app/__winston/enter?pass=${token}&path=${encodeURIComponent("/notes?x=1")}`,
      { cookie: `__Host-winston_site_nonce=${nonce}` },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/notes?x=1");
    const [pass, clearedNonce] = setCookies(response);
    expect(pass).toStartWith(`__Host-winston_site_pass=${token};`);
    expect(clearedNonce).toStartWith("__Host-winston_site_nonce=;");
  });

  test("a pass without this browser's nonce, for another site, for someone else, or expired is refused", async () => {
    const enter = (
      token: string,
      cookie = `__Host-winston_site_nonce=${nonce}`,
    ) =>
      get(`https://blog.runwinston.app/__winston/enter?pass=${token}`, {
        cookie,
      });
    expect((await enter(passToken(), "")).status).toBe(403);
    expect(
      (await enter(passToken(), "__Host-winston_site_nonce=b")).status,
    ).toBe(403);
    expect((await enter(passToken({ site: "other" }))).status).toBe(403);
    expect((await enter(passToken({ sub: "usr_other" }))).status).toBe(403);
    expect((await enter(passToken({ exp: Date.now() - 1 }))).status).toBe(403);
    expect((await enter("forged.pass")).status).toBe(403);
  });

  test("coming back never redirects off the site", async () => {
    const response = await get(
      `https://blog.runwinston.app/__winston/enter?pass=${passToken()}&path=${encodeURIComponent("//evil.example")}`,
      { cookie: `__Host-winston_site_nonce=${nonce}` },
    );
    expect(response.headers.get("location")).toBe("/");
  });

  test("dev sites over http use plain cookie names, without Secure", async () => {
    const response = await dispatch(
      new Request("http://blog.sites.localhost:3003/"),
      deps({ domain: "sites.localhost" }),
    );
    const [cookie] = setCookies(response);
    expect(cookie).toStartWith("winston_site_nonce=");
    expect(cookie).not.toContain("Secure");
  });

  test("a site that throws (over its limits, or a bug) gets the failed page", async () => {
    const response = await get(
      "https://blog.runwinston.app/",
      { cookie: ownerCookie() },
      { site: () => Promise.reject(new Error("Exceeded CPU limit")) },
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
