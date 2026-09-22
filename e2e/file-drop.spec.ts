import { expect, test, type Locator, type Page } from "@playwright/test";

const path = "/Users/tester/Desktop/Screen Capture.png";
type Point = { x: number; y: number };

async function point(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, type: "enter" | "over" | "drop" | "leave", position?: Point, paths?: string[]) {
  await page.evaluate(({ type, position, paths }) => {
    (window as unknown as {
      mock: { drag: (type: string, payload: { position?: Point; paths?: string[] }) => void };
    }).mock.drag(type, { position, paths });
  }, { type, position, paths });
}

async function promise(page: Page, type: "pending" | "received", id: string, position?: Point, paths: string[] = [], error?: string) {
  await page.evaluate(({ type, id, position, paths, error }) => {
    (window as unknown as { mock: { drag: (type: string, payload: unknown) => void } })
      .mock.drag(type, { id, position, paths, error });
  }, { type, id, position, paths, error });
}

async function paste(page: Page, selector: string, files: boolean) {
  await page.evaluate(({ selector, files }) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    // WebKit rejects a constructed ClipboardEvent with a DataTransfer, so describe the clipboard here.
    Object.defineProperty(event, "clipboardData", {
      value: { files: files ? [new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" })] : [] },
    });
    document.querySelector<HTMLTextAreaElement>(selector)!.dispatchEvent(event);
  }, { selector, files });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('#tiles .tile[data-tab="t1"] .composer textarea')).toBeVisible();
});

test("file drop uses the final destination and discards cancelled or hidden targets", { tag: "@webkit" }, async ({ page }) => {
  const first = page.locator('#tiles .tile[data-tab="t1"]');
  const second = page.locator('#tiles .tile[data-tab="t3"]');
  await drag(page, "enter", await point(first), [path]);
  await expect(first).toHaveClass(/dropping/);
  await drag(page, "drop", await point(second), [path]);
  await expect(first.locator(".injchip")).toHaveCount(0);
  await expect(second.locator(".cfiles .injchip")).toContainText("Screen Capture.png");
  await expect(page.locator(".dropping")).toHaveCount(0);

  const at = await point(first);
  await first.hover();
  await drag(page, "enter", at, [path]);
  await drag(page, "drop", await point(page.locator("#deskbar")), [path]);
  await expect(first.locator(".cfiles .injchip")).toHaveCount(0);
  await drag(page, "enter", at, [path]);
  await drag(page, "leave");
  await expect(page.locator(".dropping")).toHaveCount(0);
  await drag(page, "drop", { x: -100, y: -100 }, [path]);
  await expect(first.locator(".cfiles .injchip")).toHaveCount(0);
  await drag(page, "enter", at, [path]);
  await first.locator(".topen").click();
  await drag(page, "drop", { x: -100, y: -100 }, [path]);
  await expect(first.locator(".cfiles .injchip")).toHaveCount(0);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toHaveCount(0);
});

test("file drop respects a modal dialog opened during the gesture", { tag: "@webkit" }, async ({ page }) => {
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  const at = await point(tile);
  await drag(page, "enter", at, [path]);
  // Use the same native mechanism as Design System forms.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.showModal();
  });
  await drag(page, "drop", at, [path]);
  await expect(page.locator(".dropping")).toHaveCount(0);
  await expect(tile.locator(".cfiles .injchip")).toHaveCount(0);
});

test("launcher file drop preserves text and does not duplicate attachments", async ({ page }) => {
  await page.locator("#railbody").getByRole("button", { name: "Create", exact: true }).click();
  const composer = page.locator("#d-prompt");
  await composer.fill("Look at this capture");
  const at = await point(composer);
  await drag(page, "drop", at, []);
  await expect(page.locator("#msg")).toContainText("Could not retrieve the dragged file");
  await drag(page, "enter", at, [path]);
  await drag(page, "drop", at, [path, path]);
  await expect(page.locator("#d-inj .injchip")).toHaveCount(1);
  await expect(composer).toHaveValue("Look at this capture");
  await expect(page.locator(".cfiles .injchip")).toHaveCount(0);
  await promise(page, "pending", "launcher", at);
  await expect(page.locator("#d-go")).toBeDisabled();
  await composer.press("Enter");
  await expect(page.locator("#veil")).toBeVisible();
  await promise(page, "received", "launcher", undefined, ["/tmp/other.png"]);
  await expect(page.locator("#d-inj .injchip")).toHaveCount(2);
  await expect(page.locator("#d-go")).toBeEnabled();
});

test("terminal file drop writes the escaped path to the correct PTY", { tag: "@webkit" }, async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  await page.locator(".tabadd .caret").click();
  await page.locator(".ui-search-picker-choice", { hasText: "New terminal" }).click();
  await expect(page.locator("#termview .xterm")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      droppedWrites: Record<string, unknown>[];
    };
    w.droppedWrites = [];
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "pty_write" && args) w.droppedWrites.push(args);
      return invoke(command, args);
    };
  });
  const at = await point(page.locator("#termview"));
  await drag(page, "enter", at, [path]);
  await drag(page, "drop", at, [path, "/tmp/a;echo.txt"]);
  const writes = await page.evaluate(() => (window as unknown as {
    droppedWrites: { session: string; data: string }[];
  }).droppedWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].session).toBe("sessao-0929:terminal");
  expect(writes[0].data).toBe("/Users/tester/Desktop/Screen\\ Capture.png /tmp/a\\;echo.txt ");
  await expect(page.locator(".cfiles .injchip")).toHaveCount(0);
});

test("thumbnail file drop delivers the capture to its original tab after navigation", async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("Analyze this capture");
  const at = await point(composer);
  // The screenshot thumbnail advertises a file promise before a path exists.
  await drag(page, "enter", at, []);
  await expect(page.locator("#chatwrap")).toHaveClass(/dropping/);
  await promise(page, "pending", "capture-1", at);
  await expect(page.locator("#msg")).toContainText("Receiving file");
  await expect(page.locator(".dropping")).toHaveCount(0);
  await expect(page.locator("#chatwrap .send")).toBeDisabled();
  await composer.press("Enter");
  await expect(composer).toHaveValue("Analyze this capture");

  // A board update can arrive between mouse press and release.
  const second = page.locator('#tabbar .tab[data-tab="t2"]');
  await second.hover();
  await page.mouse.down();
  await page.evaluate(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    return internals.invoke("rename_tab", { workspace: "sessao-0929", tab: "t2", title: "Another conversation" });
  });
  await page.mouse.up();
  await expect(second).toHaveClass(/\bon\b/);
  await expect(second).toContainText("Another conversation");
  await promise(page, "received", "capture-1", undefined, [path]);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toHaveCount(0);
  await page.locator('#tabbar .tab[data-tab="t1"]').click();
  await expect(page.locator("#chatwrap .cfiles .injchip")).toContainText("Screen Capture.png");
  await expect(composer).toHaveValue("Analyze this capture");
  await expect(page.locator("#chatwrap .send")).toBeEnabled();
});

test("promised file drops keep independent destinations and allow retry after failure", async ({ page }) => {
  const first = page.locator('#tiles .tile[data-tab="t1"]');
  const second = page.locator('#tiles .tile[data-tab="t3"]');
  await promise(page, "pending", "first", await point(first));
  await promise(page, "pending", "second", await point(second));
  await promise(page, "received", "second", undefined, ["/tmp/second.png"]);
  await promise(page, "received", "first", undefined, [], "timeout");
  await expect(page.locator("#msg")).toContainText("Could not receive the file");
  await expect(first.locator(".cfiles .injchip")).toHaveCount(0);
  await expect(second.locator(".cfiles .injchip")).toContainText("second.png");
  await promise(page, "pending", "retry", await point(first));
  await promise(page, "received", "retry", undefined, [path]);
  await promise(page, "received", "retry", undefined, ["/tmp/duplicate.png"]);
  await expect(first.locator(".cfiles .injchip")).toHaveCount(1);
  await expect(first.locator(".cfiles .injchip")).toContainText("Screen Capture.png");
});

test("image paste attaches to conversation and launcher without changing pasted text", { tag: "@webkit" }, async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("Look at this");
  await paste(page, "#chatwrap .composer textarea", false);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toHaveCount(0);
  await paste(page, "#chatwrap .composer textarea", true);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toContainText("pasted.png");
  await expect(composer).toHaveValue("Look at this");

  await page.locator("#railbody").getByRole("button", { name: "Create", exact: true }).click();
  await page.locator("#d-prompt").fill("Analyze this capture");
  await paste(page, "#d-prompt", true);
  await expect(page.locator("#d-inj .injchip")).toContainText("pasted.png");
  await expect(page.locator("#d-prompt")).toHaveValue("Analyze this capture");
});
