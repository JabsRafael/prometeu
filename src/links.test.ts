import { describe, expect, it } from "vitest";
import { external } from "./links";

describe("external links", () => {
  it("opens external HTTP and HTTPS pages", () => {
    expect(external("https://example.com/a")).toBe("https://example.com/a");
    expect(external("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("ignores non-page targets", () => {
    expect(external("#")).toBeNull();
    expect(external("javascript:alert(1)")).toBeNull();
    expect(external("file:///etc/passwd")).toBeNull();
    expect(external(null)).toBeNull();
  });
});
