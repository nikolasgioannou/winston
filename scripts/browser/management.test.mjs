/* global document, window */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/telegram", (route) =>
    route.fulfill({ json: { binding: null, challenge: null } }),
  );
  await page.route("**/api/owner/connections", (route) => route.fulfill({ json: [] }));
});

test("sidebar routes survive reload and browser history, and mobile navigation closes", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page).toHaveURL("/connections");
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connections", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.screenshot({ path: testInfo.outputPath("connections-desktop.png") });
  await page.reload();
  await expect(page.getByRole("link", { name: "Connections", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Connections" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("connections-mobile.png") });
});

test("connection sign-in returns to the requested page without restoring an old file", async ({
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
  await page.goto("/");
  await page.evaluate(() =>
    sessionStorage.setItem("winston.pending-download", "11111111-1111-4111-8111-111111111111"),
  );
  await page.goto("/connections");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL("/connections");
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
});

test("returning to a revoked session hides authenticated screens", async ({ page }) => {
  let authorized = true;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.goto("/connections");
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  authorized = false;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toHaveCount(0);
});

test("connection destinations and provider callback results return to the correct page", async ({
  page,
}) => {
  await page.goto("/?connection_result=failed");
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Connection failed. Try connecting again.");
  await page.goto("/__dev/design/pages?page=management&state=account&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await preview.getByRole("button", { name: "Open navigation" }).click();
  await preview.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
});
