import { describe, expect, it } from "vitest";
import { external } from "./links";

describe("link para fora", () => {
  it("abre http e https de fora", () => {
    expect(external("https://example.com/a")).toBe("https://example.com/a");
    expect(external("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("ignora o que não é página", () => {
    expect(external("#")).toBeNull();
    expect(external("javascript:alert(1)")).toBeNull();
    expect(external("file:///etc/passwd")).toBeNull();
    expect(external(null)).toBeNull();
  });
});
