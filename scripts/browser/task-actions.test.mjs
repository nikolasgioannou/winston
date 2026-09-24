/* global window, document */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const task = {
  id,
  revision: 1,
  state: "running",
  objective: "Read the file",
  result: null,
  waiting: null,
  createdAt: "2030-01-01T14:00:00.000000Z",
  updatedAt: "2030-01-01T14:01:00.000000Z",
};
const action = {
  id: actionId,
  intentRevision: 0,
  authorization: { operation: "device.command", target: { kind: "device", id, resource: null } },
  state: "unknown",
  decisionSource: "owner",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route(`**/api/owner/activity/${id}/history*`, (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await page.route("**/api/owner/devices", (route) => route.fulfill({ status: 503, json: {} }));
  await page.route(`**/api/owner/activity/${id}/actions*`, (route) => {
    const after = new URL(route.request().url()).searchParams.get("after");
    if (after) expect(after).toBe(actionId);
    return route.fulfill({
      json: {
        unresolved: 1,
        items: [
          after
            ? { ...action, id: "33333333-3333-4333-8333-333333333333", state: "approved" }
            : action,
        ],
        next: after ? null : actionId,
      },
    });
  });
});

test("cancel confirmation retains its revision across background updates", async ({ page }) => {
  let current = { ...task };
  let reads = 0;
  const writes = [];
  await page.route(`**/api/owner/activity/${id}`, (route) => {
    reads++;
    return route.fulfill({ json: current });
  });
  await page.route(`**/api/owner/activity/${id}/cancel`, (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    if (body.revision !== current.revision) return route.fulfill({ status: 409, json: {} });
    current = { ...current, revision: current.revision + 1, state: "canceled" };
    return route.fulfill({ json: current });
  });
  await page.goto(`/activity/${id}`);
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  expect(writes).toEqual([]);
  current = { ...current, revision: 2 };
  const previousReads = reads;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await page.getByRole("button", { name: "Stop request", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to confirm cancellation");
  expect(writes).toEqual([{ revision: 1 }]);
  await expect(page.getByRole("button", { name: "Stop request", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  await page.getByRole("button", { name: "Stop request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Current request" })).toContainText("Canceled");
  expect(writes).toEqual([{ revision: 1 }, { revision: 2 }]);
  await expect(page.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("no confirmed outcome");
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await expect(page.getByText("Not dispatched", { exact: true })).toBeVisible();
  await expect(page.getByText(`Computer · ${id}`, { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Cancel request", exact: true })).toHaveCount(0);
});

test("lost cancellation responses require a successful refresh and never auto-repeat", async ({
  page,
}) => {
  let current = { ...task };
  let failRead = false;
  let writes = 0;
  await page.route(`**/api/owner/activity/${id}`, (route) =>
    route.fulfill({ status: failRead ? 503 : 200, json: current }),
  );
  await page.route(`**/api/owner/activity/${id}/cancel`, (route) => {
    writes++;
    current = { ...current, state: "canceled", revision: 2 };
    return route.abort("failed");
  });
  await page.goto(`/activity/${id}`);
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  await page.getByRole("button", { name: "Stop request", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to confirm cancellation");
  await expect(page.getByRole("button", { name: "Stop request", exact: true })).toBeDisabled();
  failRead = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to load this request");
  failRead = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("region", { name: "Current request" })).toContainText("Canceled");
  await expect(page.getByText("Outcome unknown", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("action and cancellation review states fit mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=task-detail&state=unknown");
  await expect(page.getByText("Studio Mac", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("task-actions-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Stop request", exact: true }).click();
  await expect(page.getByText("Outcome unknown", { exact: true })).toBeVisible();
  for (const state of ["cancel-failed", "actions-error"]) {
    await page.goto(`/__dev/design/frame?page=task-detail&state=${state}`);
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
});
