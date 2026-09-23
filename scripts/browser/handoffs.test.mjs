import { expect, test } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
const fixture = {
  id,
  taskId: "22222222-2222-4222-8222-222222222222",
  taskRevision: 2,
  intentRevision: 0,
  target: { kind: "connection", service: "gmail", connectionId: null },
  detail: "Connect Gmail to find your itinerary.",
  state: "pending",
  expiresAt: "2030-01-01T00:00:00.000Z",
  resolutionId: null,
};

test("handoff survives login redirect and exposes expiry and cancellation without claiming completion", async ({
  page,
}) => {
  let signedIn = false;
  let state = "expired";
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ status: signedIn ? 200 : 401, json: {} }),
  );
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route(`**/api/owner/handoffs/${id}`, (route) =>
    route.fulfill({ json: { ...fixture, state } }),
  );
  await page.route(`**/api/owner/handoffs/${id}/renew`, (route) => {
    state = "pending";
    return route.fulfill({ json: { ...fixture, state } });
  });
  await page.route(`**/api/owner/handoffs/${id}/abandon`, (route) => {
    state = "abandoned";
    return route.fulfill({ json: { ...fixture, state } });
  });
  await page.goto(`/handoffs/${id}`);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Renew link" })).toHaveCount(0);
  signedIn = true;
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/handoffs/${id}$`));
  await page.getByRole("button", { name: "Renew link" }).click();
  await expect(page.getByRole("button", { name: "Connect Gmail" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel task" }).click();
  await expect(page.getByText("Task canceled.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("winston.pending-handoff"))).toBeNull();
});

test("handoff rejects unexpected OAuth destinations and renders actual review states", async ({
  page,
}) => {
  await page.route("**/api/owner/session", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/owner/timezone", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route(`**/api/owner/handoffs/${id}`, (route) => route.fulfill({ json: fixture }));
  await page.route(`**/api/owner/handoffs/${id}/connect`, (route) =>
    route.fulfill({ json: { url: "https://unexpected.example/" } }),
  );
  await page.goto(`/handoffs/${id}`);
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(page.getByRole("alert")).toHaveText("Unable to finish setup. Please try again.");
  await expect(page).toHaveURL(new RegExp(`/handoffs/${id}$`));
  await page.goto("/__dev/design/pages?page=handoff&state=expired&viewport=mobile");
  const preview = page.frameLocator("iframe");
  await preview.getByRole("button", { name: "Renew link" }).click();
  await preview.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(preview.getByText("Connected. Winston can continue the task.")).toBeVisible();
});
