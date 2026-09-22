import { describe, expect, it } from "vitest";
import { grouped, kilo, parseContext, sectionTotal, tokenCount } from "./context";

const SAMPLE = `## Context Usage

**Model:** claude-fable-5  
**Tokens:** 20.2k / 1m (2%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4k | 0.4% |
| MCP tools (deferred) | 14.3k | 1.4% |
| Free space | 976.8k | 97.7% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__a__x | a | 250 |
| mcp__a__y | a | 200 |
| mcp__b__z | b | 100 |
| mcp__b__w | b | 100 |
| mcp__b__v | b | 100 |
| mcp__b__u | b | 100 |
| mcp__b__t | b | 100 |
| mcp__b__s | b | 100 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| para-memory-files | User | ~190 |
`;

describe("parseContext", () => {
  it("reads the model, usage, categories and sections", () => {
    const r = parseContext(SAMPLE)!;
    expect(r.model).toBe("claude-fable-5");
    expect([r.used, r.total, r.pct]).toEqual(["20.2k", "1m", 2]);
    expect(r.categories.map((c) => [c.name, c.n, c.pct])).toEqual([
      ["System prompt", 4000, 0.4],
      ["MCP tools (deferred)", 14300, 1.4],
      ["Free space", 976800, 97.7],
    ]);
    expect(r.sections.map((s) => [s.title, s.headers.length, s.rows.length])).toEqual([
      ["MCP Tools", 3, 8],
      ["Skills", 3, 1],
    ]);
    expect(sectionTotal(r.sections[0])).toBe(1050);
    expect(sectionTotal(r.sections[1])).toBe(190);
  });

  it("groups large sections by the second column and preserves small sections", () => {
    const r = parseContext(SAMPLE)!;
    expect(grouped(r.sections[0])!.map((g) => [g.name, g.n, g.rows.length])).toEqual([
      ["a", 450, 2],
      ["b", 600, 6],
    ]);
    expect(grouped(r.sections[1])).toBeNull();
  });

  it("returns null for content that is not a report", () => {
    expect(parseContext("## Cost\n\ntotal")).toBeNull();
  });

  it("parses token counts and thousands", () => {
    expect(tokenCount("24k")).toBe(24000);
    expect(tokenCount("1m")).toBe(1_000_000);
    expect(tokenCount("~190")).toBe(190);
    expect(tokenCount("x")).toBe(0);
    expect([kilo(368), kilo(3132), kilo(24000), kilo(976_800), kilo(1_000_000)]).toEqual(["368", "3.1k", "24k", "977k", "1m"]);
  });
});
