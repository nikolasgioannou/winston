/* global window */
import { expect, test } from "@playwright/test";

const controls = "/__dev/design/pages?page=foundation&state=controls&viewport=mobile";

test("deep links select a real responsive preview and reset local edits", async ({ page }) => {
  await page.goto(controls);
  const preview = page.frameLocator("iframe");

  await expect(page.getByRole("heading", { name: "Component foundation" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCSS("width", "390px");
  await preview.getByLabel("Computer name").fill("Changed locally");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(preview.getByLabel("Computer name")).toHaveValue("Studio Mac");

  await page.getByRole("combobox", { name: "Viewport", exact: true }).click();
  await page.getByRole("option", { name: "Desktop · 1280px" }).click();
  await expect(page.locator("iframe")).toHaveCSS("width", "1280px");
  await page.goBack();
  await expect(page.locator("iframe")).toHaveCSS("width", "390px");
});

test("state selection contains dialogs in the preview and links survive reload", async ({
  page,
}) => {
  await page.goto(controls);
  await page.getByRole("combobox", { name: "State", exact: true }).click();
  await page.getByRole("option", { name: "Feedback", exact: true }).click();
  await page.reload();

  const preview = page.frameLocator("iframe");
  const trigger = preview.getByRole("button", { name: "Review connection" });
  await trigger.click();
  await expect(preview.getByRole("dialog", { name: "Connect an account" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/state=feedback/);
});

test("feedback links include page, state, and viewport", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(controls);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied.");
  const text = await page.evaluate(() => navigator.clipboard.readText());

  expect(text).toContain("Component foundation / Controls / mobile");
  expect(text).toContain(controls);
});

test("preview CSP blocks HTTP mutations before requests leave the browser", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/fixture-probe")) requests.push(request.url());
  });
  await page.goto(controls);
  await expect(page.frameLocator("iframe").getByLabel("Computer name")).toBeVisible();
  const frame = page.frames().find((item) => item.url().includes("/__dev/design/frame?"));
  const blocked = await frame.evaluate(async () => {
    try {
      await window.fetch("/api/fixture-probe", { method: "POST" });
      return false;
    } catch {
      return true;
    }
  });

  expect(blocked).toBe(true);
  expect(requests).toEqual([]);
});

test("navigation fixture uses the real mobile sidebar without leaving the preview", async ({
  page,
}) => {
  await page.goto("/__dev/design/pages?page=foundation&state=navigation&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await preview.getByRole("button", { name: "Open navigation" }).click();
  await preview.getByRole("link", { name: "Feedback", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "Feedback", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/state=navigation/);
});
