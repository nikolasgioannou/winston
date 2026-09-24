/* global document, window */
import { expect, test } from "@playwright/test";

const item = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 2,
  createdAt: "2030-01-01T14:00:00.000123Z",
  updatedAt: "2030-01-01T14:01:00.000000Z",
  objective: "Find trip notes",
  objectiveTruncated: false,
  state: "waiting",
  waiting: { kind: "device", detail: "Waiting for Studio Mac" },
  result: null,
  resultTruncated: false,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
});

test("activity retains precise cursors, escapes outcomes and recovers without writes", async ({
  page,
}, testInfo) => {
  let fail = false;
  const writes = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/owner/activity") && request.method() !== "GET")
      writes.push(request.method());
  });
  await page.route("**/api/owner/activity*", (route) => {
    if (fail) return route.fulfill({ status: 503, json: {} });
    const query = new URL(route.request().url()).searchParams;
    if (query.has("beforeId")) {
      expect(query.get("beforeId")).toBe(item.id);
      expect(query.get("beforeCreatedAt")).toBe(item.createdAt);
      return route.fulfill({
        json: {
          items: [
            {
              ...item,
              id: "22222222-2222-4222-8222-222222222222",
              state: "failed",
              waiting: null,
              result: "<img src=x onerror=alert(1)>",
              resultTruncated: true,
            },
          ],
          next: null,
        },
      });
    }
    return route.fulfill({
      json: { items: [item], next: { id: item.id, createdAt: item.createdAt } },
    });
  });
  await page.goto("/activity");
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Older requests" }).click();
  await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.getByText("Result excerpt", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("activity-desktop.png"), fullPage: true });
  fail = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to load activity");
  fail = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test("activity restores sign-in destinations and hides expired private data", async ({ page }) => {
  let authorized = false;
  let reads = 0;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route("**/api/owner/activity", (route) => {
    reads++;
    return route.fulfill({ status: authorized ? 200 : 401, json: { items: [item], next: null } });
  });
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.goto("/activity");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  expect(reads).toBe(0);
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL("/activity");
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toBeVisible();
  authorized = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toHaveCount(0);
});

test("activity review states fit mobile and error refresh recovers", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=activity&state=ready");
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(
    page.getByText("You have no events tomorrow morning.", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("activity-mobile.png"), fullPage: true });
  await page.goto("/__dev/design/frame?page=activity&state=empty");
  await expect(page.getByText("No requests yet.", { exact: true })).toBeVisible();
  await page.goto("/__dev/design/frame?page=activity&state=loading");
  await expect(page.getByRole("status")).toHaveText("Loading activity…");
  await page.goto("/__dev/design/frame?page=activity&state=error");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("You have no events tomorrow morning.", { exact: true }),
  ).toBeVisible();
});
