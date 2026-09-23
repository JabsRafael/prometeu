import { describe, expect, it } from "vitest";
import { keys, machine } from "./platform";

describe("keys", () => {
  it("keeps macOS glyphs on macOS", () => {
    expect(keys("New workspace  ⌘N", true)).toBe("New workspace  ⌘N");
  });

  it("spells modifier chords as key names elsewhere", () => {
    expect(keys("Archive  ⌘⇧D", false)).toBe("Archive  Ctrl+Shift+D");
    expect(keys("Save — ⌘S", false)).toBe("Save — Ctrl+S");
    expect(keys("⇧Enter breaks the line", false)).toBe("Shift+Enter breaks the line");
  });

  it("names a lone modifier without a trailing plus", () => {
    expect(keys("⌥ opens in the external browser", false)).toBe("Alt opens in the external browser");
  });
});

describe("machine", () => {
  it("keeps the Mac on macOS", () => {
    expect(machine("Projects on this Mac", "computer", true)).toBe("Projects on this Mac");
  });

  it("names the computer elsewhere, capitalized at the start", () => {
    expect(machine("Keep the Mac awake", "computer", false)).toBe("Keep the computer awake");
    expect(machine("Mac and display stay awake", "computer", false)).toBe("Computer and display stay awake");
    expect(machine("Projetos neste Mac", "computador", false)).toBe("Projetos neste computador");
  });

  it("leaves macOS and other words alone", () => {
    expect(machine("macOS settings for Macros", "computer", false)).toBe("macOS settings for Macros");
  });
});
