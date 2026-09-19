import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { ConversationCommandV1 } from "../src/conversation";

type RequestWindow = Window & {
  mock: { line(tab: string, event: unknown): void };
  requestControls: { session: string; frame: ConversationCommandV1 }[];
  __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
};

test("canonical request kind controls question, plan and approval cards independently of tool names", async ({ page }) => {
  await page.goto("/");
  await page.locator('.railworkspace[data-workspace="sessao-0929"] > .navitem').click();
  await expect(page.locator("#wsView")).toBeVisible();
  await page.evaluate(() => {
    const w = window as RequestWindow;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.requestControls = [];
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "chat_control") {
        w.requestControls.push(args as RequestWindow["requestControls"][number]);
        return Promise.resolve();
      }
      return invoke(command, args);
    };
  });

  for (const [kind, tool] of [
    ["question", "custom_question"], ["question", null],
    ["plan", "custom_plan"], ["plan", null],
    ["approval", "AskUserQuestion"], ["approval", null],
  ] as const) {
    const requestId = `${kind}-${tool ?? "none"}`;
    await page.evaluate(({ kind, tool, requestId }) => {
      (window as RequestWindow).mock.line("t1", {
        v: 1, type: "request.opened", at: 1, requestId, kind, tool, toolId: null,
        input: kind === "question"
          ? { questions: [{ question: "Which option?", options: [{ label: "A" }] }] }
          : {},
      });
    }, { kind, tool, requestId });

    const card = page.locator("#chatwrap .ask");
    await expect(card).toHaveCount(1);
    if (kind === "question") {
      await expect(card).toHaveClass(/\bquestion\b/);
      await card.locator(".opt").click();
      await card.locator("button.pri").click();
    } else if (kind === "plan") {
      await expect(card).toHaveClass(/\bplan\b/);
      await card.locator("button.outline").click();
    } else {
      await expect(card).not.toHaveClass(/\b(question|plan)\b/);
      await card.locator("button.pri").click();
    }
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => (window as RequestWindow).requestControls.pop())).toEqual({
      session: "t1", frame: {
        v: 1, type: "request.respond", requestId,
        response: kind === "question" ? { outcome: "answer", answers: { "Which option?": "A" } } : { outcome: "allow" },
      },
    });
  }
});


test("plan approval waits for the execution permission change", async ({ page }) => {
  await page.goto("/");
  await page.locator('.railworkspace[data-workspace="sessao-0929"] > .navitem').click();
  await expect(page.locator("#wsView")).toBeVisible();
  await page.evaluate(() => {
    const w = window as RequestWindow & { releasePermission: () => void };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.requestControls = [];
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "chat_control") {
        w.requestControls.push(args as RequestWindow["requestControls"][number]);
        if ((args?.frame as ConversationCommandV1).type === "permission.mode.set") {
          return new Promise(resolve => { w.releasePermission = () => resolve(undefined); });
        }
        return Promise.resolve();
      }
      return invoke(command, args);
    };
    w.mock.line("t1", { v: 1, type: "request.opened", at: 1, requestId: "plan-order",
      kind: "plan", tool: "ExitPlanMode", toolId: null, input: {} });
  });
  await page.locator("#chatwrap .ask.plan button.pri").first().click();
  expect(await page.evaluate(() => (window as RequestWindow).requestControls.map(c => c.frame.type)))
    .toEqual(["permission.mode.set"]);
  await page.evaluate(() => (window as unknown as { releasePermission: () => void }).releasePermission());
  await expect.poll(() => page.evaluate(() => (window as RequestWindow).requestControls.map(c => c.frame.type)))
    .toEqual(["permission.mode.set", "request.respond"]);
});


test("Gemini adapter fixture renders through the browser mock", async ({ page }) => {
  const fixture: { events: unknown[] } = JSON.parse(readFileSync(
    new URL("../src-tauri/src/gemini/fixtures/canonical-events.json", import.meta.url), "utf8",
  ));
  await page.goto("/");
  await page.locator('.railworkspace[data-workspace="sessao-0929"] > .navitem').click();
  await expect(page.locator("#wsView")).toBeVisible();
  await page.evaluate(events => {
    for (const event of events) (window as RequestWindow).mock.line("t1", event);
  }, fixture.events);
  await expect(page.locator("#chatwrap")).toContainText("Update the adapter and test it.");
  await expect(page.locator("#chatwrap .ask")).toHaveCount(1);
  await expect(page.locator("#chatwrap .ask.plan")).toBeVisible();
});


test("Gemini runtime failures use the interface language", async ({ page }) => {
  await page.goto("/");
  await page.locator('.railworkspace[data-workspace="sessao-0929"] > .navitem').click();
  await expect(page.locator("#wsView")).toBeVisible();
  await page.evaluate(() => (window as RequestWindow).mock.line("t1", {
    v: 1, type: "turn.completed", at: 1, outcome: "error", durationMs: null, costUsd: null,
    message: 'i18n:{"code":"err.gemini.start","args":{}}',
  }));
  await expect(page.locator("#chatwrap")).toContainText("Gemini não conseguiu concluir a solicitação.");
  await expect(page.locator("#chatwrap")).not.toContainText("i18n:");
});
