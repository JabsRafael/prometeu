import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const inspectorPath = fileURLToPath(new URL("../src/browser-inspector.js", import.meta.url));
type Selection = {
  url: string; selector: string; tag: string; text: string; html: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
};
type InspectorWindow = Window & {
  __prometeuInspector: {
    enabled: boolean;
    setEnabled(value: boolean): void;
    takeSelection(): Selection | null;
    selectionCurrent(): boolean;
    dispose(): void;
  };
};

async function enable(page: Page) {
  await page.evaluate(() => (window as InspectorWindow).__prometeuInspector.setEnabled(true));
}

async function takeSelection(page: Page) {
  return page.evaluate(() => (window as InspectorWindow).__prometeuInspector.takeSelection());
}

test.beforeEach(async ({ page }) => {
  // This fixture is a real page: no Prometeu frontend, IPC or browser mock is loaded.
  await page.route("http://inspector.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><body style="margin:32px;font-family:sans-serif">
      <main id="design"><a id="cta:primary" href="#next" style="display:inline-block;padding:16px;color:rgb(12, 34, 56)">Buy</a>
      <p>First</p><p>Second</p></main><div style="height:2000px"></div>
    </body></html>`,
  }));
  await page.goto("http://inspector.test/");
  await page.addScriptTag({ path: inspectorPath });
});

test("browser selects a real element without navigating and delivers HTML, styles and coordinates once", { tag: "@webkit" }, async ({ page }) => {
  const target = page.locator('[id="cta:primary"]');
  const box = (await target.boundingBox())!;
  await enable(page);
  await target.hover();
  const overlay = page.locator("[data-prometeu-inspector]");
  await expect(overlay).toBeVisible();
  expect(await overlay.boundingBox()).toEqual(box);
  await target.click();
  await expect(page).toHaveURL("http://inspector.test/");
  await expect(overlay).toHaveCount(0);
  const selected = (await takeSelection(page))!;
  expect(selected).toMatchObject({
    url: "http://inspector.test/", tag: "a", text: "Buy",
    styles: { color: "rgb(12, 34, 56)", "padding-top": "16px" }, rect: box,
    viewport: page.viewportSize(),
  });
  expect(selected.selector).toBe("#cta\\:primary");
  expect(selected.html).toContain('href="#next"');
  expect(selected.html).not.toContain("data-prometeu-inspector");
  expect(await takeSelection(page)).toBeNull();
  expect(await page.evaluate(() => (window as InspectorWindow).__prometeuInspector.enabled)).toBe(false);
  await target.click();
  await expect(page).toHaveURL("http://inspector.test/#next");
});

test("browser cancels with Escape, preserves normal clicks and removes listeners when reinjected", { tag: "@webkit" }, async ({ page }) => {
  await enable(page);
  await page.locator("a").hover();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-prometeu-inspector]")).toHaveCount(0);
  expect(await takeSelection(page)).toBeNull();
  expect(await page.evaluate(() => (window as InspectorWindow).__prometeuInspector.enabled)).toBe(false);
  await page.locator("a").click();
  await expect(page).toHaveURL(/#next$/);
  await enable(page);
  await page.addScriptTag({ path: inspectorPath });
  await enable(page);
  await page.locator("p").nth(1).click();
  const selected = (await takeSelection(page))!;
  expect(selected.selector).toBe("#design > p:nth-of-type(2)");
  expect(selected.text).toBe("Second");
  await page.evaluate(() => (window as InspectorWindow).__prometeuInspector.dispose());
  await expect(page.locator("[data-prometeu-inspector]")).toHaveCount(0);
});

test("browser removes scripts, handlers and private values without changing the original page", { tag: "@webkit" }, async ({ page }) => {
  await page.locator("main").evaluate((main) => {
    main.innerHTML = `<section id="form" style="padding:30px">
      <script>privateScript = 'script-secret'</script><style>.secret { color: red }</style>
      <input value="input-secret"><input type="password" value="password-secret">
      <textarea>textarea-secret</textarea><iframe srcdoc="iframe-secret"></iframe>
      <a onclick="alert('handler-secret')" href="java&#x09;script:alert('url-secret')">Visible</a>
    </section>`;
  });
  await enable(page);
  await page.locator("#form").click({ position: { x: 5, y: 5 } });
  const selected = (await takeSelection(page))!;
  expect(selected.text).toBe("Visible");
  for (const secret of ["script-secret", "input-secret", "password-secret", "textarea-secret", "iframe-secret", "handler-secret", "url-secret"]) {
    expect(selected.html).not.toContain(secret);
    expect(selected.text).not.toContain(secret);
  }
  expect(selected.html).not.toMatch(/<script|<style|<iframe|onclick|srcdoc/);
  await expect(page.locator('input[type="password"]')).toHaveValue("password-secret");
  await expect(page.locator("textarea")).toHaveValue("textarea-secret");
});

test("browser updates its highlight after scrolling and resizing without changing layout", { tag: "@webkit" }, async ({ page }) => {
  await page.locator("main").evaluate((main) => {
    main.replaceChildren();
    main.style.cssText = "position:sticky;top:20px;width:50vw;height:100px;background:lightgray";
  });
  const main = page.locator("main");
  const original = (await main.boundingBox())!;
  await enable(page);
  await main.hover({ position: { x: original.width - 10, y: 80 } });
  const overlay = page.locator("[data-prometeu-inspector]");
  expect(await main.boundingBox()).toEqual(original);
  await page.evaluate(() => window.scrollTo(0, 100));
  await expect.poll(() => overlay.boundingBox()).toEqual(await main.boundingBox());
  await page.setViewportSize({ width: 1200, height: 800 });
  await main.hover({ position: { x: 300, y: 80 } });
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(() => overlay.boundingBox()).toEqual(await main.boundingBox());
  await main.click({ position: { x: 300, y: 80 } });
  const selected = (await takeSelection(page))!;
  expect(selected.rect).toEqual(await main.boundingBox());
  expect(selected.viewport).toEqual({ width: 1000, height: 800 });
});

test("browser selects open Shadow DOM and resolves repeated IDs with indices", { tag: "@webkit" }, async ({ page }) => {
  await page.locator("main").evaluate((main) => {
    main.innerHTML = '<div id="host"></div>';
    main.firstElementChild!.attachShadow({ mode: "open" }).innerHTML =
      '<button id="same">First</button><button id="same">Second</button>';
  });
  await enable(page);
  await page.getByRole("button", { name: "Second" }).click();
  const selected = (await takeSelection(page))!;
  expect(selected.selector).toBe("#host >>> button:nth-of-type(2)");
  expect(selected.text).toBe("Second");
  expect(selected.tag).toBe("button");
});

test("browser bounds captures without breaking Unicode or including its own highlight", async ({ page }) => {
  await page.locator("main").evaluate((main) => {
    const target = document.createElement("div");
    target.id = `${"x".repeat(998)}😀`;
    target.textContent = `${"a".repeat(1999)}😀`;
    target.style.fontFamily = `"${"f".repeat(996)} x😀"`;
    const openingLength = target.outerHTML.indexOf(">") + 1;
    target.append(`${"b".repeat(11999 - openingLength - target.textContent.length)}😀`);
    main.replaceChildren(target);
  });
  await enable(page);
  await page.locator("main > div").click();
  const selected = (await takeSelection(page))!;
  expect(selected.text).toBe("a".repeat(1999));
  expect(selected.selector).toBe(`#${"x".repeat(998)}`);
  expect(selected.html).toHaveLength(11999);
  expect(selected.styles["font-family"].length).toBeLessThanOrEqual(1000);
  // JSON.stringify escapes lone surrogates, while valid emoji remain complete characters.
  expect(JSON.stringify(selected)).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
  // Keep the ancestor below the HTML limit so truncation cannot hide an unremoved overlay.
  await page.locator("main").evaluate(main => main.replaceChildren());
  await enable(page);
  await page.mouse.move(1, 1);
  await expect(page.locator("[data-prometeu-inspector]")).toBeVisible();
  await page.mouse.click(1, 1);
  const ancestor = (await takeSelection(page))!;
  expect(ancestor.tag).toBe("html");
  expect(ancestor.html).not.toContain("data-prometeu-inspector");
});

test("browser invalidates PNG after scrolling, resizing, reflow or cancellation without losing textual context", { tag: "@webkit" }, async ({ page }) => {
  const current = () => page.evaluate(() => (window as InspectorWindow).__prometeuInspector.selectionCurrent());
  const select = async () => {
    await page.locator("a").scrollIntoViewIfNeeded();
    // Deliver scroll and resize events from the previous assertion before selecting again.
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await enable(page);
    await page.locator("a").click();
    expect((await takeSelection(page))?.text).toBe("Buy");
    expect(await current()).toBe(true);
  };
  await enable(page);
  await page.locator("a").click();
  await page.evaluate(() => window.scrollBy(0, 20));
  await expect.poll(current).toBe(false);
  expect((await takeSelection(page))?.text).toBe("Buy");
  await select();
  await page.evaluate(() => window.scrollBy(0, 20));
  await expect.poll(current).toBe(false);
  await select();
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(current).toBe(false);
  await select();
  await page.locator("a").evaluate((element) => { element.style.marginLeft = "10px"; });
  expect(await current()).toBe(false);
  await select();
  await page.evaluate(() => history.pushState(null, "", "#changed"));
  expect(await current()).toBe(false);
  await select();
  await enable(page);
  expect(await current()).toBe(false);
  await page.keyboard.press("Escape");
  await select();
  await page.locator("a").evaluate((element) => element.remove());
  expect(await current()).toBe(false);
  await page.locator("main").evaluate((main) => { main.innerHTML = '<a href="#next">Buy</a>'; });
  await select();
  await page.evaluate(() => (window as InspectorWindow).__prometeuInspector.dispose());
  expect(await current()).toBe(false);
});
