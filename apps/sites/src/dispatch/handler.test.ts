import { describe, expect, mock, test } from "bun:test";
import type { SiteRoute } from "@winston/site-host/route";
import { dispatch, siteLimits, type DispatchDeps } from "./handler.ts";

const route: SiteRoute = {
  script: "site_1",
  ownerId: "usr_1",
  access: "private",
  paused: false,
};

const deps = (overrides: Partial<DispatchDeps> = {}): DispatchDeps => ({
  domain: "runwinston.app",
  route: (name) => Promise.resolve(name === "blog" ? route : null),
  site: () => Promise.resolve(new Response("the site")),
  admit: () => Promise.resolve(true),
  ...overrides,
});

const get = (url: string, overrides?: Partial<DispatchDeps>) =>
  dispatch(new Request(url), deps(overrides));

describe("dispatch", () => {
  test("an admitted request reaches the site's Worker, with the limits", async () => {
    const site = mock(() => Promise.resolve(new Response("the site")));
    const response = await get("https://blog.runwinston.app/a?b=1", { site });
    expect(await response.text()).toBe("the site");
    const [script, request, limits] = site.mock.calls[0] as unknown as [
      string,
      Request,
      unknown,
    ];
    expect(script).toBe("site_1");
    expect(request.url).toBe("https://blog.runwinston.app/a?b=1");
    expect(limits).toEqual(siteLimits);
  });

  test("unknown names, the bare domain and malformed routes have no site", async () => {
    expect((await get("https://other.runwinston.app/")).status).toBe(404);
    expect((await get("https://runwinston.app/")).status).toBe(404);
    const malformed = await get("https://blog.runwinston.app/", {
      route: () => Promise.resolve({ script: 1 }),
    });
    expect(malformed.status).toBe(404);
    const missingWorker = await get("https://blog.runwinston.app/", {
      site: () => null,
    });
    expect(missingWorker.status).toBe(404);
  });

  test("a paused site shows the paused page, even to someone admitted", async () => {
    const response = await get("https://blog.runwinston.app/", {
      route: () => Promise.resolve({ ...route, paused: true }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("paused");
  });

  test("a request that isn't admitted gets the private page", async () => {
    const site = mock(() => Promise.resolve(new Response("the site")));
    const response = await get("https://blog.runwinston.app/", {
      admit: () => Promise.resolve(false),
      site,
    });
    expect(response.status).toBe(403);
    expect(site).not.toHaveBeenCalled();
  });

  test("a site that throws (over its limits, or a bug) gets the failed page", async () => {
    const response = await get("https://blog.runwinston.app/", {
      site: () => Promise.reject(new Error("Exceeded CPU limit")),
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
