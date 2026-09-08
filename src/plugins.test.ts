import { describe, expect, it } from "vitest";
import { label } from "./plugins";

/// Distinguish inherited plugin selection from an explicitly empty selection; their launcher labels must remain different.
describe("o rótulo do seletor", () => {
  it("nunca escolher e escolher nenhum são frases diferentes", () => {
    expect(label(null)).not.toBe(label([]));
    expect(label(null)).toBeTruthy();
    expect(label([])).toBeTruthy();
  });

  it("um escolhido aparece pelo nome, e vários pela conta", () => {
    expect(label(["caveman"])).toBe("caveman");
    expect(label(["caveman", "ponytail"])).toContain("2");
  });
});
