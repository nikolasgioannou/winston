/* global document, window */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const detail = {
  id,
  revision: 21,
  state: "waiting",
  objective: "Find the notes",
  result: null,
  waiting: { kind: "device", detail: "Waiting for Studio Mac" },
  createdAt: "2030-01-01T14:00:00.000000Z",
  updatedAt: "2030-01-01T14:01:00.000000Z",
};
const entry = { ...detail, objectiveTruncated: false, resultTruncated: false };
test.beforeEach(async ({ page }) => {
  await page.route(`**/api/owner/activity/${id}/actions*`, (route) =>
    route.fulfill({ json: { unresolved: 0, items: [], next: null } }),
  );
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
});

test("request links show full current text and paged expandable revisions", async ({
  page,
}, testInfo) => {
  let fail = false;
  await page.route("**/api/owner/activity", (route) =>
    route.fulfill({ json: { items: [entry], next: null } }),
  );
  await page.route(`**/api/owner/activity/${id}`, (route) =>
    route.fulfill({
      json: { ...detail, objective: `${detail.objective} ${"Long request. ".repeat(180)}` },
    }),
  );
  await page.route(`**/api/owner/activity/${id}/history*`, (route) => {
    if (fail) return route.fulfill({ status: 503, json: {} });
    const before = new URL(route.request().url()).searchParams.get("beforeRevision");
    if (before !== null) {
      expect(before).toBe("2");
      return route.fulfill({
        json: {
          items: [
            {
              ...entry,
              revision: 1,
              objective: "Original request",
              state: "succeeded",
              waiting: null,
              result: "<img src=x onerror=alert(1)>",
              resultTruncated: true,
            },
          ],
          next: null,
        },
      });
    }
    return route.fulfill({ json: { items: [{ ...entry, revision: 2 }], next: 2 } });
  });
  await page.goto("/activity");
  await page.getByRole("link", { name: detail.objective, exact: true }).click();
  await expect(page).toHaveURL(`/activity/${id}`);
  await expect(page.getByRole("region", { name: "Current request" })).toContainText(
    "Long request. ".repeat(180).trim(),
  );
  await page.getByRole("button", { name: "Earlier revisions" }).click();
  await page.getByText(/Completed · .*Revision 1/).click();
  await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.getByText("Result excerpt", { exact: true })).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to load history");
  await expect(page.getByRole("region", { name: "Current request" })).toContainText(
    detail.waiting.detail,
  );
  fail = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("task-detail-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "Back to activity" }).click();
  await expect(page).toHaveURL("/activity");
});

test("request sign-in restoration and expiry protect detail and history", async ({ page }) => {
  let authorized = false;
  let reads = 0;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route(`**/api/owner/activity/${id}`, (route) => {
    reads++;
    return route.fulfill({ status: authorized ? 200 : 401, json: detail });
  });
  await page.route(`**/api/owner/activity/${id}/history`, (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: { items: [entry], next: null } }),
  );
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.goto(`/activity/${id}`);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  expect(reads).toBe(0);
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL(`/activity/${id}`);
  await expect(page.getByRole("region", { name: "Current request" })).toBeVisible();
  authorized = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Current request" })).toHaveCount(0);
});

test("request review states are usable at mobile width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=task-detail&state=ready");
  await page.getByText(/Waiting · .*Revision 2/).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("task-detail-mobile.png"), fullPage: true });
  for (const state of ["loading", "error", "history-error", "completed"]) {
    await page.goto(`/__dev/design/frame?page=task-detail&state=${state}`);
    if (state === "loading") await expect(page.getByRole("status")).toHaveText("Loading request…");
    else if (state === "completed")
      await expect(
        page.getByText("The trip notes are in Documents/Travel.", { exact: true }),
      ).toBeVisible();
    else {
      await expect(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
  }
});
