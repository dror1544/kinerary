import { expect, test } from "@playwright/test";

test("landing page routes into the SPA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Keep your family trip moving");
  await page.getByRole("link", { name: "Start a trip" }).first().click();
  await expect(page).toHaveURL(/\/sign-in\?return_to=%2Ftrips%2Fnew$/);
  // Google Identity Services draws its own button inside this container (needs an API whose profile sets web.google_client_id).
  await expect(page.getByTestId("google-signin-button")).toBeAttached();
});
