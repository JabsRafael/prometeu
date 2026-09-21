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
    state.mock.line("t1", { type: "assistant", message: {
      id: "copy-code", role: "assistant",
      content: [{ type: "text", text: sources.map((text, i) => `\`\`\`${["typescript", "diff", ""][i]}\n${text}\n\`\`\``).join("\n\n") }],
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
});
