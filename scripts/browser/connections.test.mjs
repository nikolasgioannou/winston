import { expect, test } from "@playwright/test";

test("connected accounts retain separate identities and calendar selection uses verified IDs", async ({
  page,
}) => {
  const id = "11111111-1111-4111-8111-111111111111";
  let selected = [];
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { kind: "owner" } }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/telegram", (route) =>
    route.fulfill({ json: { binding: null, challenge: null } }),
  );
  await page.route("**/api/owner/connections", (route) =>
    route.fulfill({
      json: [
        {
          id,
          service: "calendar",
          subject: "a",
          email: "a@example.com",
          scopes: [],
          status: "connected",
          revision: 0,
          calendars: selected,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          service: "gmail",
          subject: "b",
          email: "b@example.com",
          scopes: [],
          status: "connected",
          revision: 0,
          calendars: [],
        },
      ],
    }),
  );
  await page.route(`**/api/owner/connections/${id}/calendars`, (route) => {
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON()).toEqual({ revision: 0, ids: ["calendar-a"] });
      selected = ["calendar-a"];
      return route.fulfill({ json: {} });
    }
    return route.fulfill({
      json: [{ id: "calendar-a", summary: "Personal", accessRole: "owner" }],
    });
  });
  await page.goto("/connections");
  await expect(page.getByText("a@example.com")).toBeVisible();
  await expect(page.getByText("b@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Calendars", exact: true }).click();
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Personal", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Save calendars", exact: true }).click();
  await expect(page.getByRole("button", { name: "Calendars (1)", exact: true })).toBeVisible();
});

test("connection previews show real account states without network actions", async ({ page }) => {
  await page.goto("/__dev/design/pages?page=connections&state=connected&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await expect(preview.getByText("alex@example.com")).toBeVisible();
  await expect(preview.getByText("work@example.com")).toBeVisible();
  await preview.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  await expect(preview.getByRole("button", { name: "Connect Gmail", exact: true })).toBeDisabled();
});

test("disconnect preview affects only the selected account and keeps reconnect available", async ({
  page,
}) => {
  await page.goto("/__dev/design/pages?page=connections&state=connected&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await preview.getByRole("button", { name: "Disconnect", exact: true }).first().click();
  await expect(preview.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(1);
  await expect(preview.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(2);
});
