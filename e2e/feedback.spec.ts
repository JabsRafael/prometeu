import { expect, test } from "@playwright/test";

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

function attempts(page: import("@playwright/test").Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("mock:feedbackAttempts") ?? "[]") as Record<string, unknown>[]);
}
