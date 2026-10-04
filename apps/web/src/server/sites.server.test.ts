import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { importSitePassKey, verifySitePass } from "@winston/site-host/pass";
import {
  sitePassPublicKey,
  sitePassSigningKey,
} from "@winston/site-host/pass-sign";
import { sitePassRedirect } from "./sites.server";

const passKey = randomBytes(32).toString("hex");
const nonce = "f".repeat(32);

const redirect = (query: Record<string, string>) =>
  sitePassRedirect({
    userId: "usr_1",
    query: new URLSearchParams(query),
    passKey,
    sitesUrl: "https://runwinston.app",
  });

describe("opening a private site", () => {
  test("sends the browser back to the site with a pass for the signed-in user", async () => {
    const location = new URL(
      redirect({ site: "blog", nonce, path: "/notes?x=1" }) ?? "",
    );
    expect(location.origin + location.pathname).toBe(
      "https://blog.runwinston.app/__winston/enter",
    );
    expect(location.searchParams.get("path")).toBe("/notes?x=1");
    const key = await importSitePassKey(
      sitePassPublicKey(sitePassSigningKey(passKey)),
    );
    const pass = await verifySitePass(
      location.searchParams.get("pass") ?? "",
      key,
    );
    expect(pass).toMatchObject({ sub: "usr_1", site: "blog", nonce });
  });

  test("refuses names that aren't sites and missing or malformed nonces", () => {
    expect(redirect({ site: "evil.example.com/x", nonce })).toBeUndefined();
    expect(redirect({ site: "Blog", nonce })).toBeUndefined();
    expect(redirect({ site: "blog" })).toBeUndefined();
    expect(redirect({ site: "blog", nonce: "short" })).toBeUndefined();
  });
});
