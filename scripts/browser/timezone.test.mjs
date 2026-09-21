/* global document, window */
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "America/New_York" });

const initial = { timezone: "UTC", revision: 0, source: "default", observedAt: null };

test("sign-in immediately renders while timezone synchronization handles a conflicting tab", async ({
  page,
}) => {
  const writes = [];
  let profile = initial;
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { kind: "owner" } }));
  await page.route("**/api/owner/timezone", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: profile });

      return;
    }

    const update = route.request().postDataJSON();
    writes.push(update);
    if (writes.length === 1) {
      profile = {
        timezone: "Europe/London",
        revision: 1,
        source: "browser",
        observedAt: "2026-09-21T12:00:00Z",
      };
      await route.fulfill({ status: 409, json: profile });
    } else {
      profile = { ...profile, timezone: update.timezone, revision: 2 };
      await route.fulfill({ json: profile });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("You’re signed in.");
  await expect.poll(() => writes.length).toBe(2);
  expect(writes).toEqual([
    { timezone: "America/New_York", revision: 0 },
    { timezone: "America/New_York", revision: 1 },
  ]);
});

test("foreground return observes the current timezone again and ignores invalid observations", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    window.testTimezone = "America/New_York";
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { ...original.call(this), timeZone: window.testTimezone };
    };
  });
  let reads = 0;
  const writes = [];
  let profile = initial;
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { kind: "owner" } }));
  await page.route("**/api/owner/timezone", async (route) => {
    if (route.request().method() === "PUT") {
      const update = route.request().postDataJSON();
      writes.push(update);
      profile = {
        timezone: update.timezone,
        revision: profile.revision + 1,
        source: "browser",
        observedAt: "2026-09-21T12:00:00Z",
      };
    } else {
      reads += 1;
    }

    await route.fulfill({ json: profile });
  });
  await page.goto("/");
  await expect.poll(() => writes.length).toBe(1);
  await page.evaluate(() => {
    window.testTimezone = "Asia/Tokyo";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ timezone: "Asia/Tokyo", revision: 1 });

  const readsBeforeInvalid = reads;
  await page.evaluate(() => {
    window.testTimezone = "Not/AZone";
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => reads).toBeGreaterThan(readsBeforeInvalid);
  await expect(page.getByRole("status")).toHaveText("You’re signed in.");
  expect(writes.length).toBe(2);
});

test("timezone failures never block the signed-in screen", async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { kind: "owner" } }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("You’re signed in.");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
