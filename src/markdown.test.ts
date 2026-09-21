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

describe("code blocks", () => {
  it("adds copy controls only to blocks and escapes their source", () => {
    const html = md('```html\n<img title="x"> & test\n```\n\n`inline`');
    expect(html.match(/class="ui-button ghost sm md-code-copy"/g)).toHaveLength(1);
    expect(html).toContain('data-code="&lt;img title=&quot;x&quot;&gt; &amp; test"');
    expect(html).not.toContain('<img');
    expect(md('```diff\n-old\n+new\n```')).toContain('class="code tdiff"');
  });
});
