import { expect, test } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHlcAAAAASUVORK5CYII=", "base64");

test("feedback preserves draft and attachment on failure and retries the same submission", async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/feedback", async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    await route.fulfill(requests.length === 1
      ? { status: 503, json: { error: "unavailable" } }
      : { status: 201, json: { id: body.id } });
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Feedback", exact: true });
  await expect(page.locator(".railfoot").getByRole("button", { name: "Feedback", exact: true })).toBeVisible();
  await expect(page.locator(".railfoot > :last-child")).toHaveText("Feedback");
  await expect(trigger).toHaveText("Feedback");
  await expect(page.locator(".ui-feedback .ui-feedback-trigger")).toHaveCount(0);
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Deixe seu feedback" });
  await expect(panel).toContainText("tratado em privado");
  const description = panel.getByRole("textbox");
  await expect(description).toBeFocused();
  const send = panel.getByRole("button", { name: "Enviar feedback" });
  await description.fill("   "); await send.click();
  expect(requests).toHaveLength(0);
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
  await expect(panel.getByRole("link")).toHaveCount(0);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]).toMatchObject({ kind: "idea", source: "desktop", image: { type: "image/png", data: png.toString("base64") } });
  await expect(description).toHaveValue(""); await expect(panel.getByRole("img")).toBeHidden();
});

test("feedback stays usable above modal dialogs, captures a preview and fits mobile", async ({ page }) => {
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
