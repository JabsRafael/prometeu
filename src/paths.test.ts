import { describe, expect, it } from "vitest";
import { begin, typing } from "./paths";

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

describe("o + escreve o @ que abre a lista", () => {
  it("na caixa vazia, e no fim do que já está escrito", () => {
    expect(begin("", 0)).toEqual({ text: "@", cut: 1 });
    expect(begin("veja ", 5)).toEqual({ text: "veja @", cut: 6 });
  });

  it("separa da palavra anterior", () => {
    expect(begin("veja", 4)).toEqual({ text: "veja @", cut: 6 });
  });

  it("escreve onde o cursor está, e não no fim", () => {
    expect(begin("veja  depois", 5)).toEqual({ text: "veja @ depois", cut: 6 });
  });

  it("não põe um segundo @ em quem já está escrevendo um caminho", () => {
    expect(begin("veja @app/mo", 12)).toEqual({ text: "veja @app/mo", cut: 12 });
  });
});
