import { expect, test, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator(".setnavitem").getByText("General", { exact: true }).click();
  await page.locator('details[data-settings-disclosure="notifications"] > summary').click();
  return page.locator(".notification-settings");
}

// Switch pseudo-elements and native radio sizing can conflict with app-wide input styles.
// Browser layout and keyboard interaction need coverage beyond preference unit tests.
test("@webkit notifications: keyboard controls retain native geometry and activate the preview", async ({ page }) => {
  const settings = await openSettings(page);
  const master = settings.getByRole("switch", { name: "Receive notifications", exact: false });
  await expect(master).not.toBeChecked();
  await expect(settings.getByRole("radio", { name: "Notch", exact: true })).toBeDisabled();
  await master.focus();
  await page.keyboard.press("Space");
  expect(await master.evaluate(element => getComputedStyle(element, "::after").width)).toBe("14px");
  await settings.getByRole("radio", { name: "Notch", exact: true }).check();
  expect(await settings.getByRole("radio", { name: "Notch", exact: true }).evaluate(element => element.getBoundingClientRect().width)).toBe(14);
  await settings.getByRole("button", { name: "Test notification" }).click();
  await expect(page.locator(".notification-mock")).toContainText("Your input is needed.");
  await expect(page.locator(".notification-mock")).toHaveCSS("border-bottom-left-radius", "18px");
  await expect(page.locator(".notification-mock")).toHaveCSS("height", "96px");
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator(".notification-mock")).toHaveCount(0);
  await settings.getByRole("radio", { name: "No visual", exact: true }).check();
  await expect(settings.getByRole("button", { name: "Test notification" })).toBeDisabled();
  await settings.getByRole("switch", { name: "Play a sound on this Mac", exact: false }).check();
  await expect(settings.getByRole("button", { name: "Test notification" })).toBeEnabled();

});

test("notifications: live completion opens its conversation and does not replay", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:notification-permission", "default"));
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  // Hold the initial native read while the user enables banners; it must not overwrite authorization.
  await page.evaluate(() => {
    const ipc = (window as unknown as { __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    } }).__TAURI_INTERNALS__;
    const invoke = ipc.invoke;
    ipc.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "notification_permission" && !args?.request) {
        await new Promise<void>(resolve => window.addEventListener("release-permission", () => resolve(), { once: true }));
      }
      return result;
    };
  });
  await page.locator("#settings").click();
  await page.locator(".setnavitem").getByText("General", { exact: true }).click();
  await page.locator('details[data-settings-disclosure="notifications"] > summary').click();
  const settings = page.locator(".notification-settings");
  const master = settings.getByRole("switch", { name: "Receive notifications", exact: false });
  await master.check();
  await expect(master).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("release-permission")));
  await expect(settings.getByRole("button", { name: "Test notification" })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("mock:notification-permission"))).toBe("granted");
  await page.clock.install();
  await page.evaluate(() => {
    const mock = (window as unknown as { mock: { line(tab: string, event: unknown): void } }).mock;
    mock.line("t1", { v: 1, at: 1, type: "session.state", state: "busy" });
    mock.line("t1", { v: 1, at: 2, type: "assistant.started", messageId: "notice-test" });
    mock.line("t1", { v: 1, at: 3, type: "turn.completed", outcome: "ok", message: "", durationMs: 1, costUsd: null });
  });
  await page.clock.runFor(1_100);
  await expect(page.locator(".notification-mock")).toContainText("Ready for your review.");
  await page.getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect(page.locator("#wsView")).toBeVisible();
  await expect(page.locator('#tabbar [data-tab="t1"]')).toHaveClass(/on/);
  await expect(page.locator(".notification-mock")).toHaveCount(0);
  await page.evaluate(() => {
    const mock = (window as unknown as { mock: { line(tab: string, event: unknown): void } }).mock;
    mock.line("t1", { v: 1, at: 3, type: "turn.completed", outcome: "ok", message: "", durationMs: 1, costUsd: null });
  });
  await page.clock.runFor(1_100);
  await expect(page.locator(".notification-mock")).toHaveCount(0);
});
