/* global document, window */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const device = {
  id,
  name: "Studio Mac",
  platform: "macos",
  appVersion: "1.0.0",
  protocolVersion: 1,
  capabilities: ["command"],
  revision: 3,
  isDefault: false,
  revoked: false,
  createdAt: "2030-01-01T00:00:00.000Z",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/devices/presence", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/workspaces*", (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
});

test("availability refresh is independent from device controls and never keeps a failed ready status", async ({
  page,
}, testInfo) => {
  let status = "ready";
  let failed = false;
  await page.route("**/api/owner/devices", (route) => route.fulfill({ json: [device] }));
  await page.route("**/api/owner/devices/presence", (route) =>
    failed
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: [{ deviceId: id, status, lastSeenAt: "2030-01-01T12:00:00.000Z" }] }),
  );
  await page.goto("/computers");
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  failed = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Unable to refresh availability.");
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeEnabled();
  failed = false;
  status = "locked";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  status = "unreachable";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Unreachable", { exact: true })).toBeVisible();
  await expect(page.getByText("Last seen", { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-mobile.png"),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("computer controls use observed revisions and revoke only after confirmation", async ({
  page,
}, testInfo) => {
  let current = device;
  const writes = [];
  await page.route("**/api/owner/devices", (route) => route.fulfill({ json: [current] }));
  await page.route(new RegExp(`/api/owner/devices/${id}(?:/(?:default|revoke))?$`), (route) => {
    const body = route.request().postDataJSON();
    expect(body.revision).toBe(current.revision);
    const action = route.request().url().split("/").at(-1);
    writes.push(action);
    current = {
      ...current,
      revision: current.revision + 1,
      name: action === id ? body.name : current.name,
      isDefault: action === "revoke" ? false : action === "default" || current.isDefault,
      revoked: action === "revoke" || current.revoked,
    };
    expect(route.request().method()).toBe(action === id ? "PATCH" : "POST");
    return route.fulfill({ json: current });
  });
  await page.goto("/computers");
  await expect(page.getByText("Registered", { exact: true })).toBeVisible();
  await expect(page.getByText("Online", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Computer name", { exact: true }).fill("Desk Mac");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: "Desk Mac", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Make default" }).click();
  await expect(page.getByText("Default", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("computers-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Keep access" }).click();
  expect(writes).toEqual([id, "default"]);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Revoke access", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  expect(writes).toEqual([id, "default", "revoke"]);
});

test("stale and uncertain changes require refresh without retrying writes", async ({ page }) => {
  let current = device;
  let calls = 0;
  await page.route("**/api/owner/devices", (route) => route.fulfill({ json: [current] }));
  await page.route(`**/api/owner/devices/${id}`, (route) => {
    calls++;
    expect(route.request().postDataJSON().revision).toBe(current.revision);
    current = {
      ...current,
      revision: current.revision + 1,
      name: calls === 1 ? "Other change" : "Saved despite lost response",
    };
    return calls === 1 ? route.fulfill({ status: 409, json: {} }) : route.abort("failed");
  });
  await page.goto("/computers");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Computer name", { exact: true }).fill("My draft");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm");
  await expect(page.getByLabel("Computer name", { exact: true })).toHaveValue("My draft");
  await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Other change", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved despite lost response" })).toBeVisible();
  expect(calls).toBe(2);
});

test("cloud computer paging and expired sessions do not expose private data", async ({ page }) => {
  let authorized = false;
  let reads = 0;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route("**/api/owner/devices", (route) => {
    reads++;
    return route.fulfill({ status: authorized ? 200 : 401, json: [device] });
  });
  await page.route("**/api/owner/workspaces*", (route) => {
    const after = new URL(route.request().url()).searchParams.get("after");
    if (after) expect(after).toBe(id);
    return route.fulfill({
      json: {
        items: [
          {
            id: after ? secondId : id,
            name: after ? "Second cloud computer" : "Winston's computer",
            state: after ? "paused" : "active",
            revision: 0,
          },
        ],
        next: after ? null : id,
      },
    });
  });
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.goto("/computers");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  expect(reads).toBe(0);
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL("/computers");
  await page.getByRole("button", { name: "More cloud computers" }).click();
  await expect(
    page.getByRole("heading", { name: "Second cloud computer", exact: true }),
  ).toBeVisible();
  authorized = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Studio Mac", exact: true })).toHaveCount(0);
});

test("computer review uses real controls and fits mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=computers&state=ready");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Computer name", { exact: true }).fill("Travel Mac");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: "Travel Mac", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("computers-mobile.png"), fullPage: true });
  const refreshBounds = await page
    .getByRole("button", { name: "Refresh", exact: true })
    .boundingBox();
  expect(refreshBounds).not.toBeNull();
  expect(refreshBounds.x + refreshBounds.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto("/__dev/design/frame?page=computers&state=uncertain");
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeEnabled();
});

test("pairing codes survive list refresh and cancel only the observed challenge", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const secret = `wdp_${"p".repeat(43)}`;
  let creates = 0;
  let cancels = 0;
  await page.route("**/api/owner/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/owner/devices/pairing", (route) => {
    creates++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ name: "Travel Mac" });
    return route.fulfill({
      json: { id, secret, expiresAt: new Date(Date.now() + 300_000).toISOString() },
    });
  });
  await page.route(`**/api/owner/devices/pairing/${id}`, (route) => {
    cancels++;
    expect(route.request().method()).toBe("DELETE");
    return cancels === 1 ? route.abort("failed") : route.fulfill({ status: 204 });
  });
  await page.goto("/computers");
  await page.getByRole("button", { name: "Connect a computer", exact: true }).click();
  await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
  await expect(page.getByText("Enter a computer name.", { exact: true })).toBeVisible();
  expect(creates).toBe(0);
  await page.getByLabel("New computer name").fill(" Travel Mac ");
  await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue(secret);
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue(secret);
  expect(page.url()).not.toContain(secret);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(secret);
  await page.getByRole("button", { name: "Close and cancel unused code" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm cancellation");
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveCount(0);
  expect(cancels).toBe(1);
  await page.getByRole("button", { name: "Retry cancellation" }).click();
  await expect(page.getByRole("button", { name: "Connect a computer", exact: true })).toBeVisible();
  expect(creates).toBe(1);
  expect(cancels).toBe(2);
});

test("pairing expires in memory and uncertain or malformed responses never retry automatically", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2030-01-01T12:00:00.000Z") });
  let creates = 0;
  await page.route("**/api/owner/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/owner/devices/pairing", (route) => {
    creates++;
    if (creates === 2) return route.abort("failed");
    return route.fulfill({
      json: {
        id,
        secret: creates === 3 ? "malformed-secret" : `wdp_${"p".repeat(43)}`,
        expiresAt: "2030-01-01T12:05:00.000Z",
      },
    });
  });
  await page.goto("/computers");
  await page.getByRole("button", { name: "Connect a computer", exact: true }).click();
  await page.getByLabel("New computer name").fill("Travel Mac");
  await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
  await page.clock.fastForward(300_001);
  await expect(page.getByText("Code expired. Create a new one.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm the code");
  await page.clock.fastForward(60_000);
  expect(creates).toBe(2);
  await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm the code");
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveCount(0);
  expect(creates).toBe(3);
});

test("pairing review states use the real form and fit a mobile viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=computers&state=pairing-form");
  await page.getByLabel("New computer name").fill("Travel Mac");
  await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("computer-pairing-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close and cancel unused code" }).click();
  await expect(page.getByRole("button", { name: "Connect a computer", exact: true })).toBeVisible();
  for (const state of [
    "pairing-creating",
    "pairing-closing",
    "pairing-expired",
    "pairing-error",
    "pairing-cancel-error",
  ]) {
    await page.goto(`/__dev/design/frame?page=computers&state=${state}`);
    await expect(
      page.getByRole("region", { name: "Connect a computer", exact: true }),
    ).toBeVisible();
  }
});
