import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/telegram", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
});

test("a temporary session failure recovers without repeating Google sign-in", async ({ page }) => {
  let reads = 0;
  let signIns = 0;
  await page.route("**/api/owner/session", (route) => {
    reads += 1;

    return route.fulfill({ status: reads === 1 ? 503 : 200, json: {} });
  });
  await page.route("**/api/auth/sign-in/social", (route) => {
    signIns += 1;

    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  expect(reads).toBe(2);
  expect(signIns).toBe(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("session retries are bounded and persistent failures have an accurate message", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/owner/session", (route) => {
    reads += 1;

    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText(
    "Unable to check your session. Please try again.",
  );
  expect(reads).toBe(2);
});

test("unauthorized sessions are not retried", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/owner/session", (route) => {
    reads += 1;

    return route.fulfill({ status: 401, json: {} });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  expect(reads).toBe(1);
});

test("sign-in failures offer retry and never redirect to an unexpected host", async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://untrusted.example" } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("alert")).toHaveText("Unable to sign in. Please try again.");
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("OAuth denial remains visible and its query parameters are removed", async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto("/?error=access_denied");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("signed-in users can sign out and review fixtures remain interactive", async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: { kind: "owner" } }));
  await page.route("**/api/auth/sign-out", (route) => route.fulfill({ json: { success: true } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();

  await page.goto("/__dev/design/pages?page=sign-in&state=error&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await expect(preview.getByRole("alert")).toBeVisible();
  await preview.getByRole("button", { name: "Try again" }).click();
  await preview.getByRole("button", { name: "Continue with Google" }).click();
  await expect(preview.getByRole("button", { name: "Opening Google…" })).toBeDisabled();
});
