import { describe, expect, it } from "vitest";
import { arrange } from "./desk-layout";

/// Preserve user-defined desk order, remove closed tabs, append newcomers, and avoid duplicates.
describe("arrange", () => {
  it("preserves saved order, removes missing workspaces and appends new ones", () => {
    expect(arrange(["a", "b", "c", "d"], ["c", "x", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("uses board order when no order is saved", () => {
    expect(arrange(["b", "a"], [])).toEqual(["b", "a"]);
  });

  it("does not duplicate workspaces when saved order contains duplicates", () => {
    expect(arrange(["a", "b"], ["b", "b", "a"])).toEqual(["b", "a"]);
  });
});
