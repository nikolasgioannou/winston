/* global document, window */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const accountId = "33333333-3333-4333-8333-333333333333";
const fixture = {
  id,
  ownerId: "22222222-2222-4222-8222-222222222222",
  purpose: "Check my travel plans",
  revision: 3,
  state: "proposed",
  sources: [],
  agreement: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scope: [
    { operation: "gmail.read", target: { kind: "connection", id: accountId, resource: null } },
  ],
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/connections", (route) =>
    route.fulfill({
      json: [
        {
          id: accountId,
          service: "gmail",
          subject: "fixture",
          email: "alex@example.com",
          scopes: [],
          status: "connected",
          revision: 0,
          calendars: [],
        },
      ],
    }),
  );
});

test("responsibility agreement reviews scope and persists lifecycle changes", async ({
  page,
}, testInfo) => {
  let current = fixture;
  const writes = [];
  await page.route("**/api/owner/responsibilities", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/*`, (route) => {
    const action = route.request().url().split("/").at(-1);
    writes.push([action, route.request().postDataJSON().revision]);
    current = {
      ...current,
      revision: current.revision + 1,
      state: action === "end" ? "ended" : action === "pause" ? "paused" : "active",
      agreement: { proposalRevision: 3, at: fixture.createdAt },
    };
    return route.fulfill({ json: current });
  });
  await page.goto("/responsibilities");
  await expect(page.getByText("Read email · alex@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Review agreement" }).click();
  expect(writes).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("responsibilities-desktop.png") });
  await page.getByRole("button", { name: "Confirm agreement" }).click();
  await expect(page.getByText("Agreed", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("Agreed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "End", exact: true }).click();
  await page.getByRole("button", { name: "End responsibility", exact: true }).click();
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  expect(writes).toEqual([
    ["agree", 3],
    ["pause", 4],
    ["resume", 5],
    ["end", 6],
  ]);
  await expect(page.getByRole("button", { name: "Review agreement" })).toHaveCount(0);
});

test("an uncertain agreement is never resent without reading current state", async ({ page }) => {
  let current = fixture;
  let writes = 0;
  await page.route("**/api/owner/responsibilities", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/agree`, (route) => {
    writes++;
    current = {
      ...fixture,
      state: "active",
      revision: 4,
      agreement: { proposalRevision: 3, at: fixture.createdAt },
    };
    return route.abort("failed");
  });
  await page.goto("/responsibilities");
  await page.getByRole("button", { name: "Review agreement" }).click();
  await page.getByRole("button", { name: "Confirm agreement" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm");
  await expect(page.getByRole("button", { name: "Review agreement" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Agreed", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("a changed proposal cannot be agreed through a stale review", async ({ page }) => {
  let current = fixture;
  await page.route("**/api/owner/responsibilities", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/agree`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ revision: 3 });
    return route.fulfill({ status: 409, json: {} });
  });
  await page.goto("/responsibilities");
  await page.getByRole("button", { name: "Review agreement" }).click();
  current = { ...fixture, revision: 4, purpose: "A different responsibility" };
  await page.getByRole("button", { name: "Confirm agreement" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("heading", { name: current.purpose })).toBeVisible();
});

test("responsibility review is interactive on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=responsibilities&state=proposed");
  await page.getByRole("button", { name: "Review agreement" }).click();
  await page.screenshot({ path: testInfo.outputPath("responsibilities-mobile.png") });
  await page.getByRole("button", { name: "Confirm agreement" }).click();
  await expect(page.getByText("Agreed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("a responsibility link returns after sign-in and missing scope names block agreement", async ({
  page,
}) => {
  let authorized = false;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.route("**/api/owner/responsibilities", (route) =>
    route.fulfill({ json: { items: [fixture], next: null } }),
  );
  await page.route("**/api/owner/connections", (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto("/responsibilities");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL("/responsibilities");
  await expect(page.getByRole("button", { name: "Review agreement" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeEnabled();
});
