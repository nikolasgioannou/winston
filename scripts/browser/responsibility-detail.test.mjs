/* global document, window */
import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const accountId = "33333333-3333-4333-8333-333333333333";
const fixture = {
  id,
  ownerId: "22222222-2222-4222-8222-222222222222",
  purpose: "Check my travel plans",
  revision: 3,
  state: "active",
  sources: [],
  agreement: { proposalRevision: 2, at: "2026-01-01T00:00:00.000Z" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scope: [
    { operation: "gmail.read", target: { kind: "connection", id: accountId, resource: null } },
  ],
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/owner/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/owner/workspaces*", (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/owner/connections", (route) =>
    route.fulfill({
      json: [
        {
          id: accountId,
          service: "gmail",
          subject: "fixture",
          email: "alex@example.com",
          scopes: [],
          status: "connected",
          revision: 0,
          calendars: [],
        },
      ],
    }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/sources`, (route) =>
    route.fulfill({
      json: {
        id,
        revision: 3,
        items: [
          {
            messageId: "44444444-4444-4444-8444-444444444444",
            revision: 0,
            status: "current",
            kind: "text",
            text: "Watch my trip <script>not executable</script>",
            transcript: null,
            truncated: false,
            sentAt: {
              instant: "2026-01-01T15:00:00.000Z",
              timezone: "America/New_York",
              offset: "-05:00",
            },
          },
        ],
      },
    }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/history*`, (route) =>
    route.fulfill({ json: { items: [fixture], next: null } }),
  );
});

test("detail links show escaped source instructions, older revisions and explicit edits", async ({
  page,
}, testInfo) => {
  let current = fixture;
  const writes = [];
  await page.route("**/api/owner/responsibilities", (route) =>
    route.fulfill({ json: { items: [current], next: null } }),
  );
  await page.route(`**/api/owner/responsibilities/${id}`, (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      current = {
        ...current,
        ...body,
        revision: current.revision + 1,
        state: "proposed",
        agreement: null,
      };
    }
    return route.fulfill({ json: current });
  });
  await page.route(`**/api/owner/responsibilities/${id}/sources`, (route) =>
    route.fulfill({
      json: {
        id,
        revision: current.revision,
        items: [
          {
            messageId: "44444444-4444-4444-8444-444444444444",
            revision: 0,
            status: "current",
            kind: "text",
            text: "Watch my trip <script>not executable</script>",
            transcript: null,
            truncated: false,
            sentAt: {
              instant: "2026-01-01T15:00:00.000Z",
              timezone: "America/New_York",
              offset: "-05:00",
            },
          },
        ],
      },
    }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/history*`, (route) =>
    route.fulfill({
      json: route.request().url().includes("before=3")
        ? {
            items: [
              {
                ...fixture,
                revision: 2,
                purpose: "Original plan",
                state: "proposed",
                agreement: null,
              },
            ],
            next: null,
          }
        : { items: [current], next: 3 },
    }),
  );
  await page.goto("/responsibilities");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page).toHaveURL(`/responsibilities/${id}`);
  await expect(page.getByText("Watch my trip <script>not executable</script>")).toBeVisible();
  await expect(page.getByText(/America\/New_York/)).toBeVisible();
  await page.getByRole("button", { name: "Older changes" }).click();
  await page.locator("summary").filter({ hasText: "Proposed" }).click();
  await expect(page.getByText("Original plan")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("responsibility-detail-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit responsibility", exact: true }).click();
  await page.getByLabel("Purpose", { exact: true }).fill("Check only next week's trip");
  await page.getByRole("button", { name: "Remove scope item 1" }).click();
  await expect(
    page.getByText("Saving requires a new agreement and cancels existing schedules."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Review agreement" })).toBeVisible();
  expect(writes).toEqual([{ revision: 3, purpose: "Check only next week's trip", scope: [] }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: current.purpose })).toBeVisible();
  await page.getByRole("button", { name: "Back to responsibilities" }).click();
  await expect(page).toHaveURL("/responsibilities");
});

test("uncertain edits preserve the draft and require reload before another write", async ({
  page,
}) => {
  let current = fixture;
  let writes = 0;
  await page.route(`**/api/owner/responsibilities/${id}`, (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      current = {
        ...fixture,
        ...route.request().postDataJSON(),
        revision: 4,
        state: "proposed",
        agreement: null,
      };
      return route.abort("failed");
    }
    return route.fulfill({ json: current });
  });
  await page.goto(`/responsibilities/${id}`);
  await page.getByRole("button", { name: "Edit responsibility", exact: true }).click();
  await page.getByLabel("Purpose", { exact: true }).fill("New purpose");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm");
  await expect(page.getByLabel("Purpose", { exact: true })).toHaveValue("New purpose");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await page.getByRole("button", { name: "Reload responsibility" }).click();
  await expect(page.getByLabel("Purpose", { exact: true })).toHaveValue("New purpose");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(writes).toBe(1);
});

test("stale edits retain their reviewed revision until the owner reloads", async ({ page }) => {
  let current = fixture;
  let writes = 0;
  await page.route(`**/api/owner/responsibilities/${id}`, (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      expect(route.request().postDataJSON().revision).toBe(3);
      return route.fulfill({ status: 409, json: {} });
    }
    return route.fulfill({ json: current });
  });
  await page.goto(`/responsibilities/${id}`);
  await page.getByRole("button", { name: "Edit responsibility", exact: true }).click();
  await page.getByLabel("Purpose", { exact: true }).fill("My draft");
  current = { ...fixture, revision: 4, purpose: "Changed elsewhere" };
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByLabel("Purpose", { exact: true })).toHaveValue("My draft");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await page.getByRole("button", { name: "Reload responsibility" }).click();
  await expect(page.getByLabel("Purpose", { exact: true })).toHaveValue("Changed elsewhere");
  expect(writes).toBe(1);
});

test("ended responsibilities are read-only and missing source evidence is explicit", async ({
  page,
}) => {
  await page.route(`**/api/owner/responsibilities/${id}`, (route) =>
    route.fulfill({ json: { ...fixture, state: "ended" } }),
  );
  await page.route(`**/api/owner/responsibilities/${id}/sources`, (route) =>
    route.fulfill({
      json: {
        id,
        revision: 3,
        items: [
          { messageId: "44444444-4444-4444-8444-444444444444", revision: 0, status: "changed" },
        ],
      },
    }),
  );
  await page.goto(`/responsibilities/${id}`);
  await expect(page.getByText(/This message changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit responsibility", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Review agreement" })).toHaveCount(0);
  await page.route(`**/api/owner/responsibilities/${id}/sources`, (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to load source instructions");
});

test("responsibility deep links survive sign-in without fetching private content early", async ({
  page,
}) => {
  let authorized = false;
  let reads = 0;
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: authorized ? 200 : 401, json: {} }),
  );
  await page.route(`**/api/owner/responsibilities/${id}`, (route) => {
    reads++;
    return route.fulfill({ json: fixture });
  });
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "https://accounts.google.com/fixture" } }),
  );
  await page.route("https://accounts.google.com/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "Synthetic sign-in" }),
  );
  await page.goto(`/responsibilities/${id}`);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/fixture");
  expect(reads).toBe(0);
  authorized = true;
  await page.goto("/");
  await expect(page).toHaveURL(`/responsibilities/${id}`);
  await expect(page.getByRole("heading", { name: fixture.purpose })).toBeVisible();
});

test("real detail and edit previews fit mobile and require fresh agreement", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__dev/design/frame?page=responsibility-detail&state=ready");
  await expect(page.getByRole("heading", { name: "Source instructions" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("responsibility-detail-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit responsibility", exact: true }).click();
  await page.getByLabel("Purpose", { exact: true }).fill("Watch tomorrow's flight");
  await page.screenshot({
    path: testInfo.outputPath("responsibility-edit-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: "Watch tomorrow's flight" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review agreement" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
