/* global document, window */
import { expect, test } from "@playwright/test";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const calendar = "33333333-3333-4333-8333-333333333333";
const account = {
  subject: "fixture",
  email: "personal@example.com",
  service: "gmail",
  scopes: [],
  status: "connected",
  revision: 0,
  calendars: [],
};

async function choose(page, label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/owner/workspaces*", (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await page.route("**/api/owner/connections", (route) =>
    route.fulfill({
      json: [
        { ...account, id: first },
        { ...account, id: second, email: "work@example.com" },
        { ...account, id: calendar, service: "calendar", calendars: ["travel@example.com"] },
      ],
    }),
  );
});

test("permissions save only the selected account and keep the reviewed revision", async ({
  page,
}, testInfo) => {
  let rules = { revision: 3, rules: [] };
  const writes = [];
  let fail = false;
  await page.route("**/api/owner/permissions", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: rules });
    const input = route.request().postDataJSON();
    writes.push(input);
    if (fail) {
      rules = { revision: rules.revision + 1, rules: [] };
      return route.fulfill({ status: 409, json: {} });
    }
    const { revision, ...rule } = input;
    rules = { revision: revision + 1, rules: [rule] };
    return route.fulfill({ json: { revision: rules.revision } });
  });
  await page.goto("/permissions");
  await choose(page, "Account or computer", "Gmail · work@example.com");
  await choose(page, "Action", "Send email");
  await choose(page, "Permission", "Allow");
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Save permission" }).click();
  await expect(page.getByRole("button", { name: "Save permission" })).toBeEnabled();
  expect(writes).toEqual([
    {
      target: { kind: "connection", id: second, resource: null },
      operation: "gmail.send",
      decision: "allow",
      revision: 3,
    },
  ]);
  await expect(page.getByRole("combobox", { name: "Permission", exact: true })).toContainText(
    "Allow",
  );
  await page.screenshot({ path: testInfo.outputPath("permissions-desktop.png"), fullPage: true });
  fail = true;
  await choose(page, "Permission", "Deny");
  await page.getByRole("button", { name: "Save permission" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm");
  await expect(page.getByRole("button", { name: "Save permission" })).toBeDisabled();
  expect(writes[1].revision).toBe(4);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Permission", exact: true })).toContainText(
    "Ask each time",
  );
  expect(writes).toHaveLength(2);
});

test("account denial overrides selected calendars and unavailable accounts cannot be allowed", async ({
  page,
}) => {
  await page.route("**/api/owner/permissions", (route) =>
    route.fulfill({
      json: {
        revision: 2,
        rules: [
          {
            target: { kind: "connection", id: calendar, resource: null },
            operation: "calendar.read",
            decision: "deny",
          },
          {
            target: { kind: "connection", id: calendar, resource: "travel@example.com" },
            operation: "calendar.read",
            decision: "allow",
          },
        ],
      },
    }),
  );
  await page.goto("/permissions");
  await choose(page, "Account or computer", "Calendar · personal@example.com · travel@example.com");
  await choose(page, "Action", "Read calendar");
  await expect(
    page.getByText(
      "This account denies this action for all calendars. Change the account permission first.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save permission" })).toBeDisabled();
  await choose(page, "Account or computer", "Calendar · personal@example.com · All calendars");
  await choose(page, "Action", "Read calendar");
  await expect(page.getByRole("combobox", { name: "Permission", exact: true })).toBeEnabled();
  await page.route("**/api/owner/connections", (route) =>
    route.fulfill({ json: [{ ...account, id: first, status: "disconnected" }] }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await choose(page, "Account or computer", "Gmail · personal@example.com · disconnected");
  await choose(page, "Action", "Send email");
  await choose(page, "Permission", "Allow");
  await expect(page.getByRole("button", { name: "Save permission" })).toBeDisabled();
  await choose(page, "Permission", "Deny");
  await expect(page.getByRole("button", { name: "Save permission" })).toBeEnabled();
});

test("permission deep links require sign-in and restore the destination", async ({ page }) => {
  let authorized = false;
  let reads = 0;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route("**/api/owner/permissions", (route) => {
    reads++;
    return route.fulfill({ json: { revision: 0, rules: [] } });
  });
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.goto("/permissions");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  expect(reads).toBe(0);
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL("/permissions");
  await expect(
    page.getByRole("combobox", { name: "Account or computer", exact: true }),
  ).toBeVisible();
});

test("a lost permission response is refreshed without repeating the grant", async ({ page }) => {
  let rules = { revision: 0, rules: [] };
  let writes = 0;
  await page.route("**/api/owner/permissions", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: rules });
    writes++;
    const { revision, ...rule } = route.request().postDataJSON();
    rules = { revision: revision + 1, rules: [rule] };
    return route.abort("failed");
  });
  await page.goto("/permissions");
  await choose(page, "Account or computer", "Gmail · personal@example.com");
  await choose(page, "Action", "Read email");
  await choose(page, "Permission", "Allow");
  await page.getByRole("button", { name: "Save permission" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm");
  await expect(page.getByRole("button", { name: "Save permission" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save permission" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Permission", exact: true })).toContainText(
    "Allow",
  );
  expect(writes).toBe(1);
});

test("permission review shows broad command consequences and works on mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=permissions&state=ready");
  await expect(
    page.getByText(
      "Commands can access files and applications on this computer. File-specific permissions do not limit commands.",
      { exact: true },
    ),
  ).toBeVisible();
  await choose(page, "Permission", "Deny");
  await page.getByRole("button", { name: "Save permission" }).click();
  await expect(page.getByRole("combobox", { name: "Permission", exact: true })).toContainText(
    "Deny",
  );
  await page.screenshot({ path: testInfo.outputPath("permissions-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto("/__dev/design/frame?page=permissions&state=uncertain");
  await expect(page.getByRole("button", { name: "Save permission" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save permission" })).toBeEnabled();
});
