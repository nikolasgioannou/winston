/* global document, window */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const fixture = {
  id,
  ownerId: "22222222-2222-4222-8222-222222222222",
  revision: 2,
  state: "active",
  objective: "Water the plants",
  sourceMessageIds: [],
  timing: {
    kind: "recurring",
    startAt: "2030-01-01T14:00:00.000Z",
    timezone: "America/New_York",
    rule: "FREQ=DAILY",
  },
  nextRunAt: "2030-01-01T14:00:00.000Z",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
});

test("schedule cancellation uses the observed revision and persists after refresh", async ({
  page,
}, testInfo) => {
  let current = fixture;
  let writes = 0;
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/schedules/${id}/cancel`, (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ revision: 2 });
    current = { ...fixture, revision: 3, state: "canceled", nextRunAt: null };
    return route.fulfill({ json: current });
  });
  await page.goto("/schedules");
  await expect(page.getByText("America/New_York", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("schedules-desktop.png") });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Keep schedule" }).click();
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Cancel schedule", exact: true }).click();
  await expect(page.getByText("Canceled", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Canceled", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("a lost cancellation response requires a read before another attempt", async ({ page }) => {
  let current = fixture;
  let writes = 0;
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/schedules/${id}/cancel`, (route) => {
    writes++;
    current = { ...fixture, revision: 3, state: "canceled", nextRunAt: null };
    return route.abort("failed");
  });
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Cancel schedule", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm the change");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Canceled", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(writes).toBe(1);
});

test("a stale cancellation cannot overwrite a newer schedule", async ({ page }) => {
  let current = fixture;
  const revisions = [];
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/schedules/${id}/cancel`, (route) => {
    revisions.push(route.request().postDataJSON().revision);
    if (revisions.length === 1) {
      current = { ...fixture, revision: 3, objective: "Water the new plants" };
      return route.fulfill({ status: 409, json: {} });
    }
    current = { ...current, revision: 4, state: "canceled", nextRunAt: null };
    return route.fulfill({ json: current });
  });
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Cancel schedule", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Water the new plants", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Cancel schedule", exact: true }).click();
  await expect(page.getByText("Canceled", { exact: true })).toBeVisible();
  expect(revisions).toEqual([2, 3]);
});

test("schedule pages load by cursor and an expired session removes private results", async ({
  page,
}) => {
  const second = {
    ...fixture,
    id: "33333333-3333-4333-8333-333333333333",
    objective: "Check the garden",
    state: "completed",
    nextRunAt: null,
  };
  let unauthorized = false;
  await page.route("**/api/owner/schedules**", (route) => {
    if (unauthorized) return route.fulfill({ status: 401, json: {} });
    const cursor = new URL(route.request().url()).searchParams.get("after");
    if (cursor) expect(cursor).toBe(id);
    return route.fulfill({
      json: cursor ? { items: [second], next: null } : { items: [fixture], next: id },
    });
  });
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Check the garden", { exact: true })).toBeVisible();
  await expect(page.getByText("No upcoming runs", { exact: true })).toBeVisible();
  unauthorized = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("Water the plants", { exact: true })).toHaveCount(0);
});

test("pause and resume use current revisions and retain the schedule timezone", async ({
  page,
}) => {
  let current = fixture;
  const revisions = [];
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/schedules/${id}/*`, (route) => {
    revisions.push(route.request().postDataJSON().revision);
    const pause = route.request().url().endsWith("/pause");
    current = {
      ...current,
      revision: current.revision + 1,
      state: pause ? "paused" : "active",
      nextRunAt: pause ? null : fixture.nextRunAt,
    };
    return route.fulfill({ json: current });
  });
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("America/New_York", { exact: true })).toBeVisible();
  expect(revisions).toEqual([2, 3]);
});

test("schedule review states are interactive and fit mobile", async ({ page }, testInfo) => {
  await page.goto("/__dev/design/frame?page=schedules&state=active");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("schedules-mobile.png") });
  await page.getByRole("button", { name: "Cancel schedule", exact: true }).click();
  await expect(page.getByText("Canceled", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
