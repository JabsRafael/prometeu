import { describe, expect, it } from "vitest";
import { mentions, short, typing } from "./paths";

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

describe("os anexos da fala viram menção", () => {
  const root = "/Users/eu/wt/app";

  it("o que está dentro do worktree vira caminho relativo", () => {
    expect(mentions([`${root}/src/main.ts`], root)).toBe("@src/main.ts");
    expect(short(`${root}/src/main.ts`, root)).toBe("src/main.ts");
  });

  it("o de fora entra inteiro", () => {
    expect(mentions(["/Users/eu/Desktop/tela.png"], root)).toBe("@/Users/eu/Desktop/tela.png");
  });

  it("vários, um espaço entre eles", () => {
    expect(mentions([`${root}/a.ts`, "/tmp/b.ts"], root)).toBe("@a.ts @/tmp/b.ts");
  });

  it("espaço no nome vai entre aspas: a menção não acaba no meio", () => {
    expect(mentions(["/Users/eu/Meus Arquivos/nota final.md"], root)).toBe('@"/Users/eu/Meus Arquivos/nota final.md"');
  });

  it("sem anexo não há menção nenhuma", () => {
    expect(mentions([], root)).toBe("");
  });

  it("sem worktree, todo caminho entra inteiro", () => {
    expect(mentions(["/tmp/a.ts"], null)).toBe("@/tmp/a.ts");
  });
});
