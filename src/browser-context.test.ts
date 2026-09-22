import { describe, expect, it } from "vitest";
import { encodeBrowserContext, splitBrowserContexts, type BrowserContext } from "./browser-context";

const sample = (): BrowserContext => ({
  selection: {
    url: "http://localhost:3100/collection", selector: "#design-button", tag: "button", text: "Add to project",
    html: '<button id="design-button">Add to project</button>',
    styles: { color: "rgb(255, 255, 255)", "font-size": "16px" },
    rect: { x: -5, y: 24, width: 180, height: 48 }, viewport: { width: 600, height: 800 },
  },
  image: "/tmp/browser café.png",
});

describe("browser context codec", () => {
  it("round-trips multiple contexts and preserves surrounding text exactly", () => {
    const first = sample();
    const second = { selection: { ...sample().selection, text: "Another selection" } };
    const encoded = `See this:\n\n${encodeBrowserContext(first)}\n\nAnd this:\n${encodeBrowserContext(second)}\nDone.\n`;
    expect(splitBrowserContexts(encoded)).toEqual(["See this:\n\n", first, "\n\nAnd this:\n", second, "\nDone.\n"]);
    expect(splitBrowserContexts(encodeBrowserContext(first))).toEqual([first]);
    expect(splitBrowserContexts(encodeBrowserContext(second))).toEqual([second]);
    expect(encodeBrowserContext(first)).toContain(`\n@${JSON.stringify(first.image)}\n`);
  });

  it("escapes HTML delimiters in JSON and keeps image paths literal for the CLI", () => {
    const context = sample();
    context.selection.html = `<div>\n</prometeu-browser-element>\n< prom > 😀</div>`;
    context.selection.text = '<prometeu-browser-element v="1">';
    context.image = "/tmp/</prometeu-browser-element>.png";
    const encoded = encodeBrowserContext(context);
    expect(encoded.split("\n")[1]).not.toContain("<");
    expect(encoded).toContain("\\u003cdiv>");
    expect(encoded).toContain(`@${JSON.stringify(context.image)}`);
    expect(splitBrowserContexts(encoded)).toEqual([context]);
  });

  it("preserves unknown versions, incomplete blocks and ordinary user text", () => {
    const good = encodeBrowserContext(sample());
    for (const text of ["", "Text with @file.png", good.replace('v="1"', 'v="2"'), good.slice(0, -1),
      good.replace("\n", " "), good.replace(/\n/g, "\r\n"), `Inline example: ${good}`,
      '<prometeu-browser-element v="2">\n' + good + '\n' + good + '\n</prometeu-browser-element>']) {
      expect(splitBrowserContexts(text)).toEqual([text]);
    }
    const malformed = good.replace('"selection":', '"unknown":');
    expect(splitBrowserContexts(`${malformed}\n\n${good}`)).toEqual([`${malformed}\n\n`, sample()]);
  });

  it("rejects mismatched mentions, binary images and unknown fields without removing text", () => {
    const good = encodeBrowserContext(sample());
    const variants = [
      good.replace(`@${JSON.stringify(sample().image)}`, '@"/tmp/other.png"'),
      good.replace(`@${JSON.stringify(sample().image)}`, ""),
      encodeBrowserContext({ ...sample(), image: "data:image/png;base64,AAAA" }),
      encodeBrowserContext({ ...sample(), image: "https://example.com/image.png" }),
      encodeBrowserContext({ ...sample(), image: "relative.png" }),
      encodeBrowserContext({ ...sample(), image: "/tmp/payload.svg" }),
      encodeBrowserContext({ ...sample(), image: "/tmp/line\nbreak.png" }),
      good.replace('{"selection":', '{"extra":true,"selection":'),
      good.replace('"styles":{', '"styles":[],"unknownStyles":{'),
      good.replace('"width":180', '"width":0'),
    ];
    for (const text of variants) expect(splitBrowserContexts(text)).toEqual([text]);
  });

  it("validates shape, UTF-8 limits and finite geometry before recognizing a context", () => {
    const changes = [
      { url: "file:///tmp/design.html" }, { url: "https://" }, { selector: "" }, { tag: "<button>" },
      { text: "é".repeat(4097) }, { html: "x".repeat(49153) }, { styles: { color: "x".repeat(4097) } },
      { styles: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`property-${i}`, "value"])) },
      { styles: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`property-${i}`, "x".repeat(4096)])) },
      { rect: { x: 0, y: 0, width: 180, height: -1 } },
      { rect: { x: 100001, y: 0, width: 180, height: 48 } },
      { viewport: { width: 600, height: Infinity } }, { viewport: { width: 600 } },
    ];
    for (const change of changes) {
      const context = { ...sample(), selection: { ...sample().selection, ...change } } as BrowserContext;
      const encoded = encodeBrowserContext(context);
      expect(splitBrowserContexts(encoded)).toEqual([encoded]);
    }
  });
});
