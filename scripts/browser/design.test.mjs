/* global document, window, getComputedStyle */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      throw new Error(message.text());
    }
  });

  await page.goto("/__dev/design/components");
});

test("select supports keyboard choices and the account combobox filters", async ({ page }) => {
  const policy = page.getByRole("combobox", { name: "Approval policy" });

  await policy.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Ask before acting", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("option", { name: "Allow actions", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(policy).toContainText("Allow actions");

  const account = page.getByRole("combobox", { name: "Account", exact: true });
  const search = page.getByRole("combobox", { name: "Search account", exact: true });

  await expect(search).toHaveCount(0);
  await account.click();
  await expect(search).toBeFocused();
  await search.fill("Work");
  await expect(page.getByRole("option", { name: "Work · alex@company.example" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Personal · alex@example.com" })).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(account).toContainText("Work · alex@company.example");
  await expect(search).toHaveCount(0);
  await expect(account).toBeFocused();

  await account.click();
  await search.fill("no such account");
  await expect(page.getByText("No matches found.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(account).toContainText("Work · alex@company.example");
});

test("dialog traps focus and restores its trigger after Escape", async ({ page }) => {
  await page.getByRole("link", { name: "Feedback", exact: true }).click();
  const trigger = page.getByRole("button", { name: "Review connection" });

  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Connect an account" });

  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("menu actions work and validation is linked to its field", async ({ page }) => {
  await page.getByRole("button", { name: "Account options" }).click();
  await page.getByRole("menuitem", { name: "Reset preferences" }).click();
  await expect(page.getByRole("status")).toHaveText("Preferences reset.");
  await expect(page.getByLabel("Name with a validation error")).toHaveAccessibleDescription(
    "Give this computer a name before continuing.",
  );
  await expect(page.getByRole("button", { name: "Unavailable" })).toBeDisabled();
});

test("mobile navigation works without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();

  const dialog = page.getByRole("dialog", { name: "Workspace navigation" });

  await expect(dialog.getByRole("navigation")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await dialog.getByRole("link", { name: "All reviews" }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await dialog.getByRole("link", { name: "Pages & states" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/__dev\/design\/pages$/);
  await expect(
    page.getByRole("heading", { name: "No application pages to review yet" }),
  ).toBeVisible();

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );

  expect(overflows).toBe(false);
});

test("sidebar changes review pages and browser history restores the active item", async ({
  page,
}) => {
  const pages = page.getByRole("link", { name: "Feedback", exact: true });
  const components = page.getByRole("link", { name: "Controls", exact: true });

  await expect(components).toHaveAttribute("aria-current", "page");
  await pages.click();
  await expect(pages).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("combobox", { name: "Account", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Controls", exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(components).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Controls", level: 1 })).toBeVisible();
});

test("reduced motion removes transitions while dialogs retain focus behavior", async ({ page }) => {
  await page.getByRole("link", { name: "Feedback", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Review connection" }).click();

  const dialog = page.getByRole("dialog", { name: "Connect an account" });

  await expect(dialog).toHaveCSS("transition-property", "none");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Review connection" })).toBeFocused();
});

test("sidebar width persists after dragging and honors its minimum and keyboard controls", async ({
  page,
}) => {
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const box = await handle.boundingBox();

  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(320, box.y + 100);
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await handle.press("Home");
  await handle.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "270");
  await handle.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "286");
});

test("controls share a fixed height, icon buttons are square, and disabled hover stays unchanged", async ({
  page,
}) => {
  for (const control of [
    page.getByLabel("Computer name"),
    page.getByRole("combobox", { name: "Account", exact: true }),
    page.getByRole("combobox", { name: "Approval policy" }),
    page.getByRole("button", { name: "Save preferences" }),
  ]) {
    await expect(control).toHaveCSS("height", "32px");
  }

  const iconButton = page.getByRole("button", { name: "Account options" });

  await expect(iconButton).toHaveCSS("height", "32px");
  await expect(iconButton).toHaveCSS("width", "32px");

  const disabled = page.getByRole("button", { name: "Unavailable" });
  const background = await disabled.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await disabled.hover();
  await expect(disabled).toHaveCSS("background-color", background);
});

test("buttons and selectors show blue focus only for keyboard navigation", async ({ page }) => {
  const account = page.getByRole("combobox", { name: "Account", exact: true });
  const policy = page.getByRole("combobox", { name: "Approval policy" });
  const menu = page.getByRole("button", { name: "Account options" });
  const save = page.getByRole("button", { name: "Save preferences" });

  for (const [control, item] of [
    [account, page.getByRole("option", { name: "Work · alex@company.example" })],
    [policy, page.getByRole("option", { name: "Allow actions", exact: true })],
    [menu, page.getByRole("menuitem", { name: "Reset preferences" })],
    [save, null],
  ]) {
    await control.click();

    if (item) {
      await item.click();
    }

    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("outline-style", "none");
    await expect(control).toHaveCSS("box-shadow", "none");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("outline-color", "rgb(35, 131, 226)");
    await expect(control).toHaveCSS("outline-width", "2px");
  }

  const input = page.getByLabel("Computer name");

  await input.click();
  await expect(input).toHaveCSS(
    "box-shadow",
    /rgb\(35, 131, 226\) 0px 0px 0px 1px inset, rgb\(35, 131, 226\) 0px 0px 0px 1px$/,
  );
});

test("shared neutrals match the measured reference surfaces", async ({ page }) => {
  await expect(page.locator("#workspace-sidebar")).toHaveCSS(
    "background-color",
    "rgb(249, 248, 247)",
  );
  await expect(page.getByRole("link", { name: "Feedback", exact: true })).toHaveCSS(
    "color",
    "rgb(125, 122, 117)",
  );
  await expect(page.getByRole("link", { name: "Controls", exact: true })).toHaveCSS(
    "background-color",
    "rgba(33, 27, 23, 0.05)",
  );
  await expect(page.getByLabel("Computer name")).toHaveCSS(
    "background-color",
    "rgba(66, 35, 3, 0.03)",
  );
});
