import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const fixture = {
  kind: "ready",
  id,
  name: "fixture.txt",
  size: 3,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

test("download uses a freshly authorized URL and preserves the filename", async ({ page }) => {
  let signatures = 0;
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route(`**/api/owner/file-deliveries/${id}`, (route) =>
    route.fulfill({ json: fixture }),
  );
  await page.route(`**/api/owner/file-deliveries/${id}/download`, (route) => {
    signatures++;
    return route.fulfill({
      json: { url: "https://storage.invalid/signed", name: "fixture.txt", expiresIn: 60 },
    });
  });
  await page.route("https://storage.invalid/signed", (route) =>
    route.fulfill({
      headers: { "Content-Disposition": 'attachment; filename="fixture.txt"' },
      contentType: "application/octet-stream",
      body: "abc",
    }),
  );
  await page.goto(`/files/${id}`);
  for (let index = 0; index < 2; index++) {
    const received = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    expect((await received).suggestedFilename()).toBe("fixture.txt");
  }
  expect(signatures).toBe(2);
});

test("file locator survives sign-in and fresh access rejects an expired download", async ({
  page,
}) => {
  let signedIn = false;
  let expired = false;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: signedIn ? 200 : 401, json: {} }),
  );
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route(`**/api/owner/file-deliveries/${id}`, (route) =>
    route.fulfill({ json: expired ? { kind: "expired" } : fixture }),
  );
  await page.route(`**/api/owner/file-deliveries/${id}/download`, (route) => {
    expired = true;
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`/files/${id}`);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("fixture.txt")).toHaveCount(0);
  signedIn = true;
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/files/${id}$`));
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(
    page.getByText("This link expired. Ask Winston to send the file again."),
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("winston.pending-download"))).toBeNull();
});

test("download rejects unsafe destinations and does not hijack a later connection handoff", async ({
  page,
}) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route(`**/api/owner/file-deliveries/${id}`, (route) =>
    route.fulfill({ json: fixture }),
  );
  await page.route(`**/api/owner/file-deliveries/${id}/download`, (route) =>
    route.fulfill({ json: { url: "javascript:alert(1)", name: "fixture.txt", expiresIn: 60 } }),
  );
  await page.goto(`/files/${id}`);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Unable to download. Please try again.");
  await page.route(`**/api/owner/handoffs/${id}`, (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.goto(`/handoffs/${id}`);
  await expect(page.getByText("This request is unavailable.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("winston.pending-download"))).toBeNull();
  await page.goto("/__dev/design/pages?page=download&state=error&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await preview.getByRole("button", { name: "Try again" }).click();
  await preview.getByRole("button", { name: "Download", exact: true }).click();
  await expect(preview.getByRole("button", { name: "Preparing download…" })).toBeDisabled();
});
