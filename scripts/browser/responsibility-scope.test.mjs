/* global document, window */
import { expect, test } from "@playwright/test";

test("scope selection preserves exact accounts, calendars and computers without duplicate grants", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = "11111111-1111-4111-8111-111111111111";
  const accountId = "33333333-3333-4333-8333-333333333333";
  const calendarId = "44444444-4444-4444-8444-444444444444";
  const computerId = "55555555-5555-4555-8555-555555555555";
  const secondComputerId = "66666666-6666-4666-8666-666666666666";
  const deviceId = "77777777-7777-4777-8777-777777777777";
  const unavailableId = "88888888-8888-4888-8888-888888888888";
  const calendar = "long-calendar-name-for-travel-with-many-people@group.calendar.google.com";
  let current = {
    id,
    ownerId: "22222222-2222-4222-8222-222222222222",
    purpose: "Check travel plans",
    revision: 0,
    state: "proposed",
    sources: [],
    agreement: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scope: [
      { target: { kind: "connection", id: accountId, resource: null }, operation: "gmail.read" },
    ],
  };
  const writes = [];
  const connection = {
    subject: "fixture",
    email: "alex@example.com",
    scopes: [],
    status: "connected",
    revision: 0,
    calendars: [],
  };
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/connections", (route) =>
    route.fulfill({
      json: [
        { ...connection, id: accountId, service: "gmail" },
        { ...connection, id: calendarId, service: "calendar", calendars: [calendar] },
        {
          ...connection,
          id: unavailableId,
          service: "gmail",
          email: "old@example.com",
          status: "disconnected",
        },
      ],
    }),
  );
  await page.route("**/api/owner/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: deviceId,
          name: "Studio Mac",
          revision: 0,
          isDefault: true,
          revoked: false,
          createdAt: current.createdAt,
          platform: "macos",
          appVersion: "1.0.0",
          protocolVersion: 1,
          capabilities: ["observe"],
        },
      ],
    }),
  );
  await page.route("**/api/owner/workspaces*", (route) =>
    route.fulfill({
      json: route.request().url().includes("after=")
        ? {
            items: [
              { id: secondComputerId, name: "Research computer", revision: 1, state: "active" },
            ],
            next: null,
          }
        : {
            items: [{ id: computerId, name: "Winston computer", revision: 1, state: "paused" }],
            next: computerId,
          },
    }),
  );
  await page.route(`**/api/owner/responsibilities/${id}`, (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      current = { ...current, ...writes.at(-1), revision: 1 };
    }
    return route.fulfill({ json: current });
  });
  await page.route(`**/api/owner/responsibilities/${id}/sources`, (route) =>
    route.fulfill({ json: { id, revision: current.revision, items: [] } }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/history*`, (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.goto(`/responsibilities/${id}`);
  await page.getByRole("button", { name: "Edit responsibility", exact: true }).click();
  const choose = async (label, name) => {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await choose("Account or computer", `Calendar · alex@example.com · ${calendar}`);
  await choose("Action", "Read calendar");
  await page.getByRole("button", { name: "Add to scope" }).click();
  await choose("Action", "Read calendar");
  await expect(page.getByRole("button", { name: "Add to scope" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("scope-mobile.png"), fullPage: true });
  await choose("Account or computer", "Gmail · old@example.com · disconnected");
  await expect(page.getByRole("combobox", { name: "Action", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add to scope" })).toBeDisabled();
  await choose("Account or computer", "Winston computer · paused");
  await expect(page.getByRole("button", { name: "Add to scope" })).toBeDisabled();
  await page.getByRole("button", { name: "More computers" }).click();
  await choose("Account or computer", "Research computer");
  await choose("Action", "Run commands");
  await page.getByRole("button", { name: "Add to scope" }).click();
  await choose("Account or computer", "Studio Mac");
  await page.getByRole("combobox", { name: "Action", exact: true }).click();
  await expect(page.getByRole("option", { name: "Use keyboard and mouse" })).toHaveCount(0);
  await page.getByRole("option", { name: "Observe screen", exact: true }).click();
  await page.getByRole("button", { name: "Add to scope" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Review agreement" })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].scope).toEqual([
    { target: { kind: "connection", id: accountId, resource: null }, operation: "gmail.read" },
    {
      target: { kind: "connection", id: calendarId, resource: calendar },
      operation: "calendar.read",
    },
    {
      target: { kind: "workspace", id: secondComputerId, resource: null },
      operation: "workspace.command",
    },
    { target: { kind: "device", id: deviceId, resource: null }, operation: "device.observe" },
  ]);
});

test("scope catalog failure can recover without losing the purpose draft", async ({ page }) => {
  await page.goto("/__dev/design/frame?page=responsibility-detail&state=choices-error");
  await page.getByLabel("Purpose", { exact: true }).fill("Keep this draft");
  await expect(page.getByRole("alert")).toContainText("Unable to load available");
  await page.getByRole("button", { name: "Reload choices" }).click();
  await expect(page.getByRole("combobox", { name: "Account or computer" })).toBeVisible();
  await expect(page.getByLabel("Purpose", { exact: true })).toHaveValue("Keep this draft");
});
