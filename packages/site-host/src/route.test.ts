import { describe, expect, test } from "bun:test";
import { parseSiteRoute, siteNameOf } from "./route.ts";

describe("site routes", () => {
  test("a site's name is the one label before the domain", () => {
    expect(siteNameOf("blog.runwinston.app", "runwinston.app")).toBe("blog");
    expect(siteNameOf("Blog.RunWinston.app", "runwinston.app")).toBe("blog");
    expect(siteNameOf("runwinston.app", "runwinston.app")).toBeNull();
    expect(siteNameOf("a.blog.runwinston.app", "runwinston.app")).toBeNull();
    expect(siteNameOf("blog.example.com", "runwinston.app")).toBeNull();
    expect(siteNameOf("blogrunwinston.app", "runwinston.app")).toBeNull();
  });

  test("a malformed entry is no route", () => {
    const route = {
      script: "site_1",
      ownerId: "usr_1",
      access: "private",
      shareKeyHash: null,
      paused: false,
    };
    expect(parseSiteRoute(route)).toEqual(route as never);
    expect(parseSiteRoute({ ...route, access: "public" })).toBeNull();
    expect(parseSiteRoute({ ...route, paused: "no" })).toBeNull();
    expect(parseSiteRoute(null)).toBeNull();
    expect(parseSiteRoute("site_1")).toBeNull();
  });
});
