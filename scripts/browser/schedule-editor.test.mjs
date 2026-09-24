/* global document, window */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const fixture = {
  id,
  ownerId: "22222222-2222-4222-8222-222222222222",
  revision: 2,
  state: "paused",
  objective: "Original instruction",
  sourceMessageIds: [],
  nextRunAt: null,
  timing: {
    kind: "recurring",
    startAt: "2030-01-01T14:00:23.456Z",
    timezone: "America/New_York",
    rule: "FREQ=WEEKLY;BYDAY=TU,FR;COUNT=20",
  },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
});

test("instruction edits preserve exact instants, custom recurrence and paused state", async ({
  page,
}) => {
  let current = fixture;
  let writes = 0;
  await page.route(`**/api/owner/schedules/${id}`, (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      expect(input).toEqual({
        revision: 2,
        objective: "New instruction\nWith another line",
        timing: fixture.timing,
      });
      writes++;
      current = { ...fixture, ...input, revision: 3 };
    }
    return route.fulfill({ json: current });
  });
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.goto(`/schedules/${id}`);
  await expect(page.getByText("This schedule will stay paused.")).toBeVisible();
  await page.getByLabel("Instruction", { exact: true }).fill("New instruction\nWith another line");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL("/schedules");
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("skipped times are rejected and repeated times require an explicit occurrence", async ({
  page,
}) => {
  const writes = [];
  await page.route(`**/api/owner/schedules/${id}`, (route) => {
    if (route.request().method() === "PUT") writes.push(route.request().postDataJSON());
    return route.fulfill({ json: fixture });
  });
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await page.goto(`/schedules/${id}`);
  await page.getByLabel("Date and time", { exact: true }).fill("2026-03-08T02:30");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("skipped by a clock change");
  expect(writes).toHaveLength(0);
  await page.getByLabel("Date and time", { exact: true }).fill("2026-11-01T01:30");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Choose which occurrence");
  await page.getByRole("combobox", { name: "This time happens twice" }).click();
  await page.getByRole("option", { name: "Second occurrence (UTC-05:00)" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL("/schedules");
  expect(writes).toHaveLength(1);
  expect(writes[0].timing.startAt).toBe("2026-11-01T06:30:00Z");
});

test("stale edits require reloading and cannot silently overwrite another revision", async ({
  page,
}) => {
  let current = fixture;
  const revisions = [];
  await page.route(`**/api/owner/schedules/${id}`, (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      revisions.push(input.revision);
      if (revisions.length === 1) {
        current = { ...fixture, revision: 3, objective: "Changed elsewhere" };
        return route.fulfill({ status: 409, json: {} });
      }
      current = { ...current, ...input, revision: 4 };
    }
    return route.fulfill({ json: current });
  });
  await page.route("**/api/owner/schedules", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.goto(`/schedules/${id}`);
  await page.getByLabel("Instruction", { exact: true }).fill("First edit");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Reload it");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await page.getByRole("button", { name: "Reload schedule" }).click();
  await expect(page.getByLabel("Instruction", { exact: true })).toHaveValue("Changed elsewhere");
  await page.getByLabel("Instruction", { exact: true }).fill("Second edit");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL("/schedules");
  expect(revisions).toEqual([2, 3]);
});

test("editor deep links survive sign-in without fetching private data beforehand", async ({
  page,
}) => {
  let authorized = false;
  let reads = 0;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route(`**/api/owner/schedules/${id}`, (route) => {
    reads++;
    return route.fulfill({ json: fixture });
  });
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.goto(`/schedules/${id}`);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  expect(reads).toBe(0);
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL(`/schedules/${id}`);
  await expect(page.getByLabel("Instruction", { exact: true })).toHaveValue(fixture.objective);
});

test("editor previews use real controls on mobile and canceled schedules cannot be edited", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=schedule-editor&state=ready");
  await expect(page.getByLabel("Instruction", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("editor-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: "Schedules", exact: true })).toBeVisible();
  await page.goto("/__dev/design/frame?page=schedule-editor&state=canceled");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
});
