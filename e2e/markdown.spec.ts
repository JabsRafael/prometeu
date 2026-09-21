import { expect, test } from "@playwright/test";

test("rodapé da conversa: copia blocos completos sem formatação e permite tentar novamente", async ({ page }) => {
  await page.goto("/");
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  const sources = ['const text = "<tag> & café";\n  console.log(text);', '-old\n+new', 'plain\n  indented'];
  await page.evaluate((sources) => {
    const state = window as unknown as {
      copied: string[];
      rejectCopy: boolean;
      mock: { line: (tab: string, line: unknown) => void };
    };
    state.copied = [];
    state.rejectCopy = false;
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => {
      if (state.rejectCopy) throw new Error("Clipboard denied");
      state.copied.push(text);
    } });
    state.mock.line("t1", { type: "stream_event", event: {
      type: "message_start", message: { id: "copy-code" },
    } });
    state.mock.line("t1", { type: "stream_event", event: {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: sources.map((text, i) => `\`\`\`${["typescript", "diff", ""][i]}\n${text}\n\`\`\``).join("\n\n") },
    } });
  }, sources);
  const blocks = page.locator("#chatwrap .md-code-block").filter({ hasText: /const text|old|plain/ });
  await expect(blocks).toHaveCount(3);
  for (let i = 0; i < sources.length; i++) {
    const copy = blocks.nth(i).getByRole("button");
    await expect(copy).toHaveAccessibleName("Copiar código");
    await copy.focus();
    await page.keyboard.press("Enter");
    await expect(copy).toHaveAttribute("aria-label", "Código copiado");
  }
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual(sources);
  await page.evaluate(() => { (window as unknown as { rejectCopy: boolean }).rejectCopy = true; });
  const retry = blocks.first().getByRole("button");
  await expect(retry).toHaveAttribute("aria-label", "Copiar código");
  await retry.click();
  await expect(page.getByText("Não foi possível copiar o código", { exact: true })).toBeVisible();
  await expect(retry).toHaveAttribute("aria-label", "Copiar código");
  await expect(retry).toBeEnabled();

  // Keep the clipboard pending while a real text delta replaces the original button.
  await page.evaluate(() => {
    const state = window as unknown as { finishCopy: () => void };
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () =>
      new Promise<void>(resolve => { state.finishCopy = resolve; }),
    });
  });
  const original = await retry.elementHandle();
  await retry.click();
  await expect(retry).toBeDisabled();
  await page.evaluate(() => {
    const state = window as unknown as { mock: { line: (tab: string, line: unknown) => void } };
    state.mock.line("t1", { type: "stream_event", event: {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\n\nStreaming update" },
    } });
  });
  await expect.poll(() => original!.evaluate(node => node.isConnected)).toBe(false);
  await page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy());
  await expect(page.locator("#msg")).toHaveText("Código copiado");
  await expect(page.locator("#msg")).not.toHaveClass(/err/);
});
