import { describe, expect, it } from "vitest";
import { flatLabel } from "./plugins";

/// Distinguish inherited plugin selection from an explicitly empty selection; their launcher labels must remain different.
describe("o rótulo do seletor", () => {
  it("nunca escolher e escolher nenhum são frases diferentes", () => {
    expect(flatLabel(null)).not.toBe(flatLabel([]));
    expect(flatLabel(null)).toBeTruthy();
    expect(flatLabel([])).toBeTruthy();
  });

  it("um escolhido aparece pelo nome, e vários pela conta", () => {
    expect(flatLabel(["caveman"])).toBe("caveman");
    expect(flatLabel(["caveman", "ponytail"])).toContain("2");
  });
});
