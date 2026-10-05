import { describe, expect, test } from "bun:test";
import {
  connectPath,
  issuerOf,
  providersIssuedBy,
  reconnectPath,
  syncedProviders,
} from "./connections.ts";

describe("provider traits", () => {
  test("Google issues Gmail's and Calendar's tokens, and Winston's mailbox has none", () => {
    expect(providersIssuedBy("google")).toEqual(["gmail", "google_calendar"]);
    expect(issuerOf("gmail")).toBe("Google");
    expect(issuerOf("winston")).toBe("the provider");
  });

  test("only Google's providers are synced and watched", () => {
    expect(syncedProviders).toEqual(["gmail", "google_calendar"]);
  });

  test("connecting and reconnecting go through the issuer's flow", () => {
    expect(connectPath("mail")).toBe("/auth/google/connect?domain=mail");
    expect(connectPath("calendar")).toBe(
      "/auth/google/connect?domain=calendar",
    );
    expect(reconnectPath({ id: "acct_1", provider: "google_calendar" })).toBe(
      "/auth/google/connect?reconnect=acct_1",
    );
    expect(reconnectPath({ id: "acct_2", provider: "winston" })).toBeNull();
  });
});
