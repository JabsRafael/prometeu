import { expect, test, type Page } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHlcAAAAASUVORK5CYII=", "base64");

const account = { user: { id: "cloud-user", name: "Gustavo Brancaglione", email: "gustavo@example.com" }, origin: "https://app.prometeu.co", offline: false };

const signedIn = (failures = 0) => `
  localStorage.setItem("mock:cloud", ${JSON.stringify(JSON.stringify(account))});
  localStorage.setItem("mock:feedbackFailures", "${failures}");
`;

test("feedback preserves draft and attachment on failure and retries the same submission", async ({ page }) => {
  await page.addInitScript(signedIn(1));
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Feedback", exact: true });
  await expect(page.locator(".railfoot").getByRole("button", { name: "Feedback", exact: true })).toBeVisible();
  await expect(page.locator(".railfoot > :last-child")).toHaveText("Feedback");
  await expect(trigger).toHaveText("Feedback");
  await expect(page.locator(".ui-feedback .ui-feedback-trigger")).toHaveCount(0);
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  await expect(panel).toContainText("tratado em privado");
  const publicReport = panel.getByRole("link", { name: "Reportar bug publicamente" });
  await expect(publicReport).toHaveAttribute("href", "https://github.com/prometeucorp/prometeu/issues/new");
  await expect(publicReport).toHaveAttribute("target", "_blank");
  await expect(publicReport).toHaveAccessibleDescription(/sem enviar descrição nem captura/);
  const description = panel.getByRole("textbox");
  await expect(description).toBeFocused();
  const send = panel.getByRole("button", { name: "Enviar feedback privado" });
  await description.fill("   "); await send.click();
  expect(await attempts(page)).toHaveLength(0);
  await description.fill("Sugestão de teste <script>não executar</script>");
  await panel.getByRole("button", { name: "Ideia", exact: true }).click();
  await panel.getByLabel("Anexar imagem", { exact: false }).setInputFiles({ name: "example.png", mimeType: "image/png", buffer: png });
  await expect(panel.getByRole("img")).toBeVisible();
  await send.click();
  await expect(panel.getByRole("alert")).toContainText("Não foi possível enviar");
  await expect(description).toHaveValue("Sugestão de teste <script>não executar</script>");
  await expect(panel.getByRole("img")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(panel).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click(); await send.click();
  await expect(panel.getByRole("status")).toContainText("Feedback enviado");
  await expect(panel.getByRole("link")).toHaveCount(1);
  const sent = await attempts(page);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[1]).toMatchObject({ kind: "idea", source: "desktop", image: { type: "image/png", data: png.toString("base64") } });
  await expect(description).toHaveValue(""); await expect(panel.getByRole("img")).toBeHidden();
});

test("feedback without an account offers connecting one instead of the form", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Feedback", exact: true });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  await expect(panel).toContainText("Conecte sua conta Prometeu");
  await expect(panel.getByRole("link", { name: "Reportar bug publicamente" })).toBeVisible();
  await expect(panel.getByRole("textbox")).toBeHidden();
  const connect = panel.getByRole("button", { name: "Conectar conta" });
  await expect(connect).toBeFocused();
  await connect.click();
  // Connecting runs the same device authorization as the account button in the sidebar.
  await expect(page.locator(".cloud-account").getByRole("status")).toHaveText("ABCD-EFGH");
  await page.evaluate(() => localStorage.setItem("mock:cloudApproved", "1"));
  await expect(page.locator(".cloud-account")).toContainText("Gustavo Brancaglione");
  await page.keyboard.press("Escape");
  await trigger.click();
  await expect(panel.getByRole("textbox")).toBeVisible();
  await expect(panel).not.toContainText("Conecte sua conta Prometeu");
});

test("feedback stays usable above modal dialogs, captures a preview and fits mobile", async ({ page }) => {
  await page.addInitScript(signedIn());
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Feedback", exact: true });
  await trigger.click();
  await page.evaluate(() => {
    const dialog = document.createElement("dialog"); dialog.id = "host-dialog";
    dialog.innerHTML = '<input aria-label="Host field">';
    document.body.append(dialog); dialog.showModal();
  });
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  await panel.getByRole("textbox").fill("Falha no modal");
  await panel.getByRole("button", { name: "Capturar tela" }).click();
  await expect(panel.getByRole("img")).toBeVisible();
  await panel.getByRole("button", { name: "Remover imagem" }).click();
  await expect(panel.getByRole("img")).toBeHidden();
  await panel.getByLabel("Anexar imagem", { exact: false }).setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(panel.getByRole("alert")).toContainText("até 5 MB");
  await page.setViewportSize({ width: 390, height: 640 });
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden(); await expect(page.locator("#host-dialog")).toBeVisible();
  await page.evaluate(() => { const dialog = document.querySelector<HTMLDialogElement>("#host-dialog")!; dialog.close(); dialog.remove(); });
  await trigger.click();
  await expect(panel.getByRole("textbox")).toHaveValue("Falha no modal");
});

test("feedback accepts a dropped image", async ({ page }) => {
  await page.addInitScript(signedIn());
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  const transfer = await page.evaluateHandle(([base64]) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], "dropped.png", { type: "image/png" }));
    return data;
  }, [png.toString("base64")]);
  await panel.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(panel).toHaveClass(/ui-feedback-dropping/);
  await panel.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(panel).not.toHaveClass(/ui-feedback-dropping/);
  await expect(panel.getByRole("img")).toBeVisible();
});

test("desktop feedback accepts a native file drop intercepted by Tauri", async ({ page }) => {
  await page.addInitScript(signedIn());
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  const box = (await panel.boundingBox())!;
  await page.evaluate(({ x, y }) => {
    (window as unknown as { mock: { drop(paths: string[], x: number, y: number): void } })
      .mock.drop(["/Users/eu/Desktop/Captura de Tela.png"], x, y);
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await expect(panel.getByRole("img")).toBeVisible();
});

// Control IPC completion explicitly so attachment races do not depend on timers.
async function deferredImages(page: Page) {
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      finishImage: (path: string, fail: boolean) => Promise<void>;
    };
    const invoke = host.__TAURI_INTERNALS__.invoke;
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (cause: unknown) => void }>();
    host.__TAURI_INTERNALS__.invoke = (command, args) => command === "feedback_image"
      ? new Promise((resolve, reject) => pending.set(String(args?.path), { resolve, reject }))
      : invoke(command, args);
    host.finishImage = async (path, fail) => {
      const request = pending.get(path)!;
      pending.delete(path);
      if (fail) request.reject(new Error("Image loading failed"));
      else request.resolve(await invoke("feedback_image", { path }));
    };
  });
  return {
    drop: (path: string) => page.evaluate(path => {
      const box = document.querySelector(".ui-feedback-panel")!.getBoundingClientRect();
      (window as unknown as { mock: { drop: (paths: string[], x: number, y: number) => void } })
        .mock.drop([path], box.x + box.width / 2, box.y + box.height / 2);
    }, path),
    finish: (path: string, fail = false) => page.evaluate(({ path, fail }) =>
      (window as unknown as { finishImage: (path: string, fail: boolean) => Promise<void> }).finishImage(path, fail), { path, fail }),
  };
}

test("feedback waits for the latest native image and ignores older results after submission", async ({ page }) => {
  await page.addInitScript(signedIn());
  await page.goto("/");
  const images = await deferredImages(page);
  await page.getByRole("button", { name: "Feedback", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  await panel.getByRole("textbox").fill("Imagem mais recente");
  const send = panel.getByRole("button", { name: "Enviar feedback privado" });
  await images.drop("/oldest.png");
  await images.drop("/older.png");
  await images.drop("/latest.png");
  await expect(send).toBeDisabled();
  await expect(panel.locator("form")).toHaveAttribute("aria-busy", "true");
  await panel.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
  expect(await attempts(page)).toHaveLength(0);
  await images.finish("/latest.png");
  await expect(send).toBeEnabled();
  await expect(panel.getByRole("img")).toBeVisible();
  const preview = await panel.getByRole("img").getAttribute("src");
  await images.finish("/oldest.png");
  await expect(panel.getByRole("img")).toHaveAttribute("src", preview!);
  await send.click();
  await expect(panel.getByRole("status")).toContainText("Feedback enviado");
  expect(await attempts(page)).toMatchObject([{ image: { type: "image/png" } }]);
  await images.finish("/older.png");
  await expect(panel.getByRole("img")).toBeHidden();
});

test("feedback ignores stale image errors and recovers from the current load failure", async ({ page }) => {
  await page.addInitScript(signedIn());
  await page.goto("/");
  const images = await deferredImages(page);
  await page.getByRole("button", { name: "Feedback", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  await panel.getByLabel("Anexar imagem", { exact: false }).setInputFiles({ name: "kept.png", mimeType: "image/png", buffer: png });
  const preview = await panel.getByRole("img").getAttribute("src");
  await images.drop("/older.png");
  await images.drop("/latest.png");
  await images.finish("/older.png", true);
  await expect(panel.getByRole("alert", { includeHidden: true })).toBeEmpty();
  await expect(panel.getByRole("button", { name: "Enviar feedback privado" })).toBeDisabled();
  await images.finish("/latest.png", true);
  await expect(panel.getByRole("alert")).toHaveText("Image loading failed");
  await expect(panel.getByRole("button", { name: "Enviar feedback privado" })).toBeEnabled();
  await expect(panel.getByRole("img")).toHaveAttribute("src", preview!);
});

for (const action of ["upload", "drop", "remove", "close", "capture"] as const) {
  test(`feedback cancels a pending native image on ${action}`, async ({ page }) => {
    await page.addInitScript(signedIn());
    await page.goto("/");
    const images = await deferredImages(page);
    const trigger = page.getByRole("button", { name: "Feedback", exact: true });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
    const upload = panel.getByLabel("Anexar imagem", { exact: false });
    await upload.setInputFiles({ name: "kept.png", mimeType: "image/png", buffer: png });
    await images.drop("/pending.png");
    if (action === "upload") await upload.setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: png });
    if (action === "drop") await panel.evaluate((node, data) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], "replacement.png", { type: "image/png" }));
      node.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
    }, png.toString("base64"));
    if (action === "remove") await panel.getByRole("button", { name: "Remover imagem" }).click();
    if (action === "close") { await page.keyboard.press("Escape"); await trigger.click(); }
    if (action === "capture") await panel.getByRole("button", { name: "Capturar tela" }).click();
    await expect(panel.getByRole("button", { name: "Enviar feedback privado" })).toBeEnabled();
    const preview = await panel.locator("img").getAttribute("src");
    await images.finish("/pending.png");
    expect(await panel.locator("img").getAttribute("src")).toBe(preview);
    await expect(panel.getByRole("alert", { includeHidden: true })).toBeEmpty();
  });
}

function attempts(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("mock:feedbackAttempts") ?? "[]") as Record<string, unknown>[]);
}
