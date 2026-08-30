import { afterEach, describe, expect, it } from "vitest";
import { h, template } from "./util";

type FakeElement = {
  className: string;
  textContent: string;
  innerHTML: string;
  innerHtmlWrites: number;
};

const realDocument = globalThis.document;

function fakeDocument() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        let innerHTML = "";
        return {
          className: "",
          textContent: "",
          innerHtmlWrites: 0,
          get innerHTML() {
            return innerHTML;
          },
          set innerHTML(value: string) {
            this.innerHtmlWrites++;
            innerHTML = value;
          },
        } satisfies FakeElement;
      },
    },
  });
}

afterEach(() => {
  if (realDocument) Object.defineProperty(globalThis, "document", { configurable: true, value: realDocument });
  else Reflect.deleteProperty(globalThis, "document");
});

describe("DOM helpers", () => {
  it.each([
    ["q.question", `<img src=x onerror="globalThis.pwned=true">`],
    ["tool label", `<svg onload="globalThis.pwned=true"></svg>`],
  ])("renders malicious %s as text", (_source, payload) => {
    fakeDocument();

    const node = h("p", "label", payload) as unknown as FakeElement;

    expect(node.textContent).toBe(payload);
    expect(node.innerHtmlWrites).toBe(0);
  });

  it("keeps app-owned markup behind the explicit template helper", () => {
    fakeDocument();

    const node = template("div", "card", "<span></span>") as unknown as FakeElement;

    expect(node.innerHTML).toBe("<span></span>");
    expect(node.innerHtmlWrites).toBe(1);
  });
});
