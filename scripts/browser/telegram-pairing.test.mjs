import { expect, test } from "@playwright/test";

test("pairing requires web confirmation before connecting", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  let started = false;
  let confirmed = false;
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { kind: "owner" } }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/telegram", (route) => {
    if (route.request().method() === "DELETE") {
      started = false;
      confirmed = false;
      return route.fulfill({ json: { disconnected: true } });
    }
    return route.fulfill({
      json: {
        binding: confirmed ? { userId: "123" } : null,
        challenge: started && !confirmed ? { id, userId: "123", name: "Alex" } : null,
      },
    });
  });
  await page.route("**/api/owner/telegram/challenge", (route) => {
    started = true;
    return route.fulfill({ json: { id, url: "https://t.me/example_bot?start=fixture" } });
  });
  await page.route("**/api/owner/telegram/confirm", (route) => {
    expect(route.request().postDataJSON()).toEqual({ id });
    confirmed = true;
    return route.fulfill({ json: { confirmed: true } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connect Telegram", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open Telegram" })).toHaveAttribute(
    "href",
    "https://t.me/example_bot?start=fixture",
  );
  await expect(page.getByRole("button", { name: "Confirm Telegram account" })).toBeVisible();
  expect(confirmed).toBe(false);
  await page.getByRole("button", { name: "Confirm Telegram account" }).click();
  await expect(page.getByText("Connected · 123")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect Telegram" }).click();
  await expect(page.getByRole("button", { name: "Connect Telegram", exact: true })).toBeVisible();
});

test("the Telegram review uses the real view without live actions", async ({ page }) => {
  await page.goto("/__dev/design/pages?page=telegram&state=candidate&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await preview.getByRole("button", { name: "Confirm Telegram account" }).click();
  await expect(preview.getByText("Connected · 123456")).toBeVisible();
  await preview.getByRole("button", { name: "Disconnect Telegram" }).click();
  await expect(
    preview.getByRole("button", { name: "Connect Telegram", exact: true }),
  ).toBeVisible();
});
