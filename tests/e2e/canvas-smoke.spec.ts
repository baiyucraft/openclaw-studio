import { expect, test } from "@playwright/test";

test("loads focused workspace empty state", async ({ page }) => {
  await page.route("**/api/studio", async (route, request) => {
    if (request.method() === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ settings: { version: 1, gateway: null, layouts: {}, focused: {} } }),
      });
      return;
    }
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ settings: { version: 1, gateway: null, layouts: {}, focused: {} } }),
    });
  });

  await page.goto("/");

  await expect(page.getByTestId("fleet-sidebar")).toBeVisible();
  await expect(page.getByTestId("focused-agent-panel")).toBeVisible();
});
