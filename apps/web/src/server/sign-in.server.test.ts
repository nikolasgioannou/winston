import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import {
  allowedEmails,
  jobs,
  users,
  vms,
  webSessions,
} from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { findSession } from "@winston/db/web-sessions";
import { count, eq } from "drizzle-orm";
import { fakeGoogle, goodClaims, idToken } from "./google.server.test";
import {
  completeGoogleSignIn,
  signInWithGoogle,
  validTimezone,
} from "./sign-in.server";

const db = await testDb();
const google = {
  clientId: goodClaims.aud,
  clientSecret: "secret",
  redirectUri: "http://localhost:3002/auth/google/callback",
};

const countOf = async (tx: DbOrTx, table: typeof users | typeof vms) =>
  (await tx.select({ n: count() }).from(table))[0]?.n;

describe("signInWithGoogle", () => {
  test("an email that isn't allowlisted creates nothing", async () => {
    await inRollback(db, async (tx) => {
      const [usersBefore, vmsBefore] = [
        await countOf(tx, users),
        await countOf(tx, vms),
      ];
      const result = await signInWithGoogle(tx, goodClaims, "Europe/London");
      expect(result).toEqual({
        outcome: "problem",
        problem: "not_allowlisted",
      });
      expect(await countOf(tx, users)).toBe(usersBefore);
      expect(await countOf(tx, vms)).toBe(vmsBefore);
    });
  });

  test("first sign-in creates the user with Google's names and the browser's time zone; the next reuses it", async () => {
    await inRollback(db, async (tx) => {
      await tx.insert(allowedEmails).values({ email: "ada@example.com" });
      const first = await signInWithGoogle(tx, goodClaims, "Europe/London");
      expect(first).toMatchObject({ outcome: "signed_in", created: true });
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, "ada@example.com"));
      expect(user).toMatchObject({
        firstName: "Ada",
        lastName: "Lovelace",
        timezone: "Europe/London",
        googleSub: "google-sub-1",
      });
      if (!user) throw new Error("expected the user");
      const again = await signInWithGoogle(tx, goodClaims, "Asia/Tokyo");
      expect(again).toEqual({
        outcome: "signed_in",
        userId: user.id,
        created: false,
      });
    });
  });

  test("sign-up requests exactly one computer and one provisioning job; signing in again adds neither", async () => {
    await inRollback(db, async (tx) => {
      await tx.insert(allowedEmails).values({ email: "ada@example.com" });
      const first = await signInWithGoogle(tx, goodClaims, undefined);
      if (first.outcome !== "signed_in") throw new Error("expected sign-in");
      await signInWithGoogle(tx, goodClaims, undefined);
      const computers = await tx
        .select({ state: vms.state, provider: vms.provider })
        .from(vms)
        .where(eq(vms.userId, first.userId));
      expect(computers).toEqual([{ state: "requested", provider: null }]);
      const queued = await tx
        .select({ type: jobs.type, dedupeKey: jobs.dedupeKey })
        .from(jobs)
        .where(eq(jobs.userId, first.userId));
      expect(queued).toEqual([
        { type: "provision_vm", dedupeKey: `provision_vm:${first.userId}` },
      ]);
    });
  });

  test("an existing user (like the seeded one) gets their Google account attached by email", async () => {
    await inRollback(db, async (tx) => {
      const seeded = await insertUser(tx, { email: "ada@example.com" });
      await tx.insert(allowedEmails).values({ email: "ADA@example.com" });
      const result = await signInWithGoogle(tx, goodClaims, undefined);
      expect(result).toEqual({
        outcome: "signed_in",
        userId: seeded.id,
        created: false,
      });
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, seeded.id));
      expect(user?.googleSub).toBe("google-sub-1");
      expect(
        await tx.select().from(vms).where(eq(vms.userId, seeded.id)),
      ).toHaveLength(1);
    });
  });

  test("an email already tied to a different Google account is refused", async () => {
    await inRollback(db, async (tx) => {
      await insertUser(tx, {
        email: "ada@example.com",
        googleSub: "someone-else",
      });
      await tx.insert(allowedEmails).values({ email: "ada@example.com" });
      expect(await signInWithGoogle(tx, goodClaims, undefined)).toEqual({
        outcome: "problem",
        problem: "oauth",
      });
    });
  });

  test("an unknown time zone falls back to UTC", async () => {
    expect(validTimezone("Mars/Olympus")).toBeUndefined();
    expect(validTimezone("America/New_York")).toBe("America/New_York");
    await inRollback(db, async (tx) => {
      await tx.insert(allowedEmails).values({ email: "ada@example.com" });
      await signInWithGoogle(tx, goodClaims, "Mars/Olympus");
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, "ada@example.com"));
      expect(user?.timezone).toBe("UTC");
    });
  });
});

describe("completeGoogleSignIn", () => {
  const cookies = {
    state: "st",
    codeVerifier: "ver",
    timezone: "Europe/London",
  };
  const query = (params: Record<string, string>) => new URLSearchParams(params);
  const deps = (tx: DbOrTx) => ({
    db: tx,
    google,
    fetch: fakeGoogle({ id_token: idToken(goodClaims) }).fetch,
  });

  test("a good callback starts a session and goes home", async () => {
    await inRollback(db, async (tx) => {
      await tx.insert(allowedEmails).values({ email: "ada@example.com" });
      const result = await completeGoogleSignIn(
        deps(tx),
        query({ code: "c", state: "st" }),
        cookies,
      );
      expect(result.redirectTo).toBe("/home");
      if (!("sessionToken" in result)) throw new Error("expected a session");
      expect((await findSession(tx, result.sessionToken))?.userId).toBe(
        result.userId,
      );
    });
  });

  test("a state that doesn't match, missing cookies, or Google's error go back to /", async () => {
    await inRollback(db, async (tx) => {
      await tx.insert(allowedEmails).values({ email: "ada@example.com" });
      for (const [params, flow] of [
        [{ code: "c", state: "forged" }, cookies],
        [
          { code: "c", state: "st" },
          { ...cookies, state: undefined },
        ],
        [
          { code: "c", state: "st" },
          { ...cookies, codeVerifier: undefined },
        ],
        [{ error: "access_denied", state: "st" }, cookies],
        [{ state: "st" }, cookies],
      ] as const)
        expect(
          await completeGoogleSignIn(deps(tx), query(params), flow),
        ).toEqual({
          redirectTo: "/?error=oauth",
        });
      expect(await tx.select().from(webSessions)).toEqual([]);
    });
  });

  test("an email that isn't allowlisted goes back to / with that state", async () => {
    await inRollback(db, async (tx) => {
      expect(
        await completeGoogleSignIn(
          deps(tx),
          query({ code: "c", state: "st" }),
          cookies,
        ),
      ).toEqual({ redirectTo: "/?error=not_allowlisted" });
    });
  });
});
