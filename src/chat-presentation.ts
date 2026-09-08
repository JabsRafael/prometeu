import { grouped, kilo, sectionTotal, type Report } from "./context";
import { type IconName } from "./icons";
import { t } from "./i18n";
import type { Block, ToolBlock } from "./timeline";
import { h, template } from "./util";

/// Pure conversation presentation: layout decisions and content truncation. Stream state and composer actions remain in chat.ts.

const RESULT_LINES = 120;
const ERROR_LINES = 36;

export function inputView(name: string, input: unknown): HTMLElement {
  const box = h("div", "tin");
  const i = (input ?? {}) as Record<string, unknown>;
  const keys = Object.keys(i).filter((k) => k !== "description");
  if (name === "Edit" && typeof i.old_string === "string" && typeof i.new_string === "string") {
    const diff = h("pre", "tdiff");
    diff.append(
      ...i.old_string.split("\n").map((l) => Object.assign(h("span", "del"), { textContent: `- ${l}\n` })),
      ...i.new_string.split("\n").map((l) => Object.assign(h("span", "add"), { textContent: `+ ${l}\n` })),
    );
    box.append(Object.assign(h("div", "tk"), { textContent: String(i.file_path ?? "") }), diff);
    return box;
  }
  for (const k of keys) {
    const v = i[k];
    const row = template("div", "trow", `<span class="tk"></span><pre></pre>`);
    row.querySelector(".tk")!.textContent = k;
    row.querySelector("pre")!.textContent = capLines(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    box.append(row);
  }
  return box;
}

const CTX_COLORS = ["#ff6b3d", "#f5a623", "#e3c84a", "#7cc576", "#4fb3bf", "#5b8def", "#9b6bd6", "#d66bb0", "#8a8a8a"];

export function contextPanel(r: Report): HTMLElement {
  const el = h("div", "ctxpanel");
  const head = template("div", "ctxhead", `<b></b><span class="model"></span><span class="use"></span>`);
  head.querySelector("b")!.textContent = t("chat.ctx.title");
  head.querySelector(".model")!.textContent = r.model;
  head.querySelector(".use")!.textContent = `${r.used} / ${r.total} · ${t("chat.ctx.used", { pct: r.pct })}`;
  el.append(head);

  const used = r.categories.filter((c) => !/^free space$/i.test(c.name));
  const free = r.categories.find((c) => /^free space$/i.test(c.name));
  const sum = used.reduce((a, c) => a + c.n, 0) || 1;
  const bar = h("div", "ctxbar");
  used.forEach((c, i) => {
    const seg = h("i", "");
    seg.style.width = `${(c.n / sum) * 100}%`;
    seg.style.background = CTX_COLORS[i % CTX_COLORS.length];
    seg.title = `${c.name} · ${c.tokens}`;
    bar.append(seg);
  });
  el.append(bar);
  const rows = h("div", "ctxrows");
  used.forEach((c, i) => {
    const row = template("div", "ctxrow", `<i class="dot"></i><span class="name"></span><span class="n"></span><span class="pct"></span>`);
    (row.querySelector(".dot") as HTMLElement).style.background = CTX_COLORS[i % CTX_COLORS.length];
    row.querySelector(".name")!.textContent = c.name;
    row.querySelector(".n")!.textContent = c.tokens;
    row.querySelector(".pct")!.textContent = `${c.pct}%`;
    rows.append(row);
  });
  if (free) {
    const row = template("div", "ctxrow free", `<i class="dot"></i><span class="name"></span><span class="n"></span><span class="pct"></span>`);
    row.querySelector(".name")!.textContent = t("chat.ctx.free");
    row.querySelector(".n")!.textContent = free.tokens;
    row.querySelector(".pct")!.textContent = `${free.pct}%`;
    rows.append(row);
  }
  el.append(rows);

  for (const s of r.sections) {
    const sec = template("details", "ctxsec", `<summary><span class="title"></span><span class="count"></span><span class="n"></span></summary>`);
    sec.querySelector(".title")!.textContent = s.title;
    sec.querySelector(".count")!.textContent = String(s.rows.length);
    sec.querySelector(".n")!.textContent = kilo(sectionTotal(s));
    const groups = grouped(s);
    if (groups) {
      for (const g of groups) {
        const grp = template("details", "ctxgrp", `<summary><span class="title"></span><span class="count"></span><span class="n"></span></summary>`);
        grp.querySelector(".title")!.textContent = g.name;
        grp.querySelector(".count")!.textContent = String(g.rows.length);
        grp.querySelector(".n")!.textContent = kilo(g.n);
        grp.append(contextTable(g.rows.map((row) => [row[0] ?? "", row[2] ?? ""])));
        sec.append(grp);
      }
    } else {
      sec.append(contextTable(s.rows));
    }
    el.append(sec);
  }
  return el;
}

function contextTable(rows: string[][]): HTMLElement {
  const table = h("div", "ctxtable");
  for (const row of rows) {
    const line = h("div", "ctxline");
    row.forEach((cell, i) => {
      const span = h("span", i === row.length - 1 ? "n" : i === 0 ? "name" : "src");
      span.textContent = cell;
      line.append(span);
    });
    table.append(line);
  }
  return table;
}

export function capLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= RESULT_LINES) return text;
  return lines.slice(0, RESULT_LINES).join("\n") + "\n" + t("chat.more", { n: lines.length - RESULT_LINES });
}

export function capError(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= ERROR_LINES) return text;
  const side = Math.floor(ERROR_LINES / 2);
  const hidden = lines.length - side * 2;
  return [...lines.slice(0, side), t("chat.more", { n: hidden }), ...lines.slice(-side)].join("\n");
}

export function errorPeek(text: string): string {
  const wrapper = /^(script (failed|completed)|wall time\b.*|output:|script error:)$/i;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => !wrapper.test(line)) ?? lines[0] ?? "";
}

export function peek(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? "";
}

export function took(ms: number): string {
  const s = ms / 1000;
  if (s < 2) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function toolIcon(name: string): IconName {
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
      return "search";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "pencil";
    case "Bash":
      return "terminal";
    case "Task":
    case "Agent":
      return "users";
    case "ExitPlanMode":
    case "EnterPlanMode":
      return "map";
    case "AskUserQuestion":
      return "message-square";
    case "WebFetch":
    case "WebSearch":
      return "globe";
    default:
      return "sparkles";
  }
}

export function wantsCard(parts: { block: Block }[]): boolean {
  return parts.filter((p) => p.block.kind === "tool").length > 1;
}

export function countTools(tools: ToolBlock[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const block of tools) counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function tallyText(tally: [string, number][]): string {
  const head = tally.slice(0, 3).map(([name, n]) => (n > 1 ? `${toolLabel(name)} ×${n}` : toolLabel(name)));
  return [...head, ...(tally.length > 3 ? ["…"] : [])].join(" · ");
}

export function toolLabel(name: string): string {
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join(" · ");
  return name;
}
