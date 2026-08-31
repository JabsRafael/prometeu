import { describe, expect, it } from "vitest";
import { typing } from "./paths";

describe("o caminho que está sendo escrito", () => {
  it("começa no @ que começa palavra", () => {
    expect(typing("veja @app/mo", 12)).toEqual({ from: 5, query: "app/mo" });
    expect(typing("@", 1)).toEqual({ from: 0, query: "" });
  });

  it("não é @ no meio de uma palavra", () => {
    expect(typing("gustavo@x", 9)).toBeNull();
  });

  it("acaba no espaço: o que já foi escrito não é mais lista", () => {
    expect(typing("@app/user.rb tem bug", 20)).toBeNull();
  });

  it("olha até o cursor, e não até o fim", () => {
    expect(typing("@app depois", 4)).toEqual({ from: 0, query: "app" });
  });
});
