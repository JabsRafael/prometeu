import { describe, expect, it } from "vitest";
import { md } from "./markdown";

describe("markdown não confiável", () => {
  it("mostra HTML cru como texto", () => {
    const html = md(`<img src=x onerror="globalThis.pwned=true">`);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("remove protocolos executáveis de links", () => {
    expect(md("[clique](javascript:alert(1))")).toContain('href="#"');
    expect(md("[site](https://example.com/a)")).toContain('href="https://example.com/a"');
  });
});
