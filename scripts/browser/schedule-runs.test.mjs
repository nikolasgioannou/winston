/* global document, window */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const responsibility = "22222222-2222-4222-8222-222222222222";
const schedule = {
  id,
  ownerId: responsibility,
  revision: 4,
  state: "canceled",
  objective: "Check the trip",
  sourceMessageIds: [],
  timing: { kind: "once", startAt: "2030-01-01T14:00:00.000Z", timezone: "America/New_York" },
  nextRunAt: null,
  responsibility: { id: responsibility, agreementRevision: 1 },
};
const run = {
  scheduleRevision: 2,
  dueAt: "2030-01-01T14:00:00.000Z",
  taskId: "33333333-3333-4333-8333-333333333333",
  state: "waiting",
  waiting: { kind: "device", detail: "Waiting for Studio Mac" },
  result: null,
  truncated: false,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [schedule], next: null } }),
  );
  await page.route(`**/api/owner/schedules/${id}`, (route) => route.fulfill({ json: schedule }));
});

test("canceled schedules retain paged history, waiting details and responsibility links", async ({
  page,
}, testInfo) => {
  let fail = false;
  const writes = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/schedules"))
      writes.push(request.url());
  });
  await page.route(`**/api/owner/schedules/${id}/runs*`, (route) => {
    if (fail) return route.fulfill({ status: 503, json: {} });
    const query = new URL(route.request().url()).searchParams;
    if (query.has("beforeRevision")) {
      expect(query.get("beforeRevision")).toBe("2");
      expect(query.get("beforeDueAt")).toBe(run.dueAt);
      return route.fulfill({
        json: {
          items: [
            {
              ...run,
              taskId: responsibility,
              state: "failed",
              waiting: null,
              result: "<img src=x onerror=alert(1)>",
              truncated: true,
            },
          ],
          next: null,
        },
      });
    }
    return route.fulfill({ json: { items: [run], next: { revision: 2, dueAt: run.dueAt } } });
  });
  await page.goto("/schedules");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(`/schedules/${id}/runs`);
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View responsibility" })).toHaveAttribute(
    "href",
    `/responsibilities/${responsibility}`,
  );
  await page.getByRole("button", { name: "Older runs" }).click();
  await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.getByText("Result excerpt", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("schedule-history-desktop.png"),
    fullPage: true,
  });
  fail = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to load runs");
  fail = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to schedules" }).click();
  await expect(page).toHaveURL("/schedules");
  expect(writes).toEqual([]);
});

test("history deep links survive sign-in and expired sessions hide private results", async ({
  page,
}) => {
  let authorized = false;
  let reads = 0;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route(`**/api/owner/schedules/${id}/runs`, (route) => {
    reads++;
    return route.fulfill({ status: authorized ? 200 : 401, json: { items: [run], next: null } });
  });
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.goto(`/schedules/${id}/runs`);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  expect(reads).toBe(0);
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL(`/schedules/${id}/runs`);
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toBeVisible();
  authorized = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("Waiting for Studio Mac", { exact: true })).toHaveCount(0);
});

test("history review states use the real page and fit mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=schedule-runs&state=ready");
  await expect(page.getByRole("heading", { name: "Schedule history" })).toBeVisible();
  await expect(page.getByText("Reminder delivered.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("schedule-history-mobile.png"),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto("/__dev/design/frame?page=schedule-runs&state=empty");
  await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
  await page.goto("/__dev/design/frame?page=schedule-runs&state=loading");
  await expect(page.getByRole("status")).toContainText("Loading runs");
  await page.goto("/__dev/design/frame?page=schedule-runs&state=error");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Reminder delivered.", { exact: true })).toBeVisible();
});
