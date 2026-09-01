import { beforeEach, describe, expect, it } from "vitest";
import { use } from "./i18n";
import { ago, bytes, span, until } from "./statusbar";

beforeEach(() => use("pt-BR"));

describe("span", () => {
  it("para em duas casas: dia e hora, ou hora e minuto", () => {
    expect(span(3 * 3600 + 15 * 60)).toBe("3h 15m");
    expect(span(3 * 86400 + 4 * 3600 + 50 * 60)).toBe("3d 4h");
    expect(span(12 * 60)).toBe("12m");
  });

  it("a casa redonda não arrasta um zero atrás", () => {
    expect(span(2 * 3600)).toBe("2h");
    expect(span(5 * 86400)).toBe("5d");
  });

  it("menos de um minuto é zero minuto, não é negativo", () => {
    expect(span(30)).toBe("0m");
    expect(span(-90)).toBe("0m");
  });
});

describe("until", () => {
  it("conta o que falta para a janela zerar", () => {
    expect(until(1000 + 3 * 3600, 1000)).toBe("3h");
  });

  // O número na tela é o da última resposta: a janela pode ter virado desde
  // então, e "zera em -2h" seria pior do que não dizer nada.
  it("janela vencida não conta para trás", () => {
    expect(until(900, 1000)).toBe("agora");
  });
});

describe("ago", () => {
  it("leitura recém-chegada não vira relógio", () => {
    expect(ago(980, 1000)).toBe("agora mesmo");
  });

  it("mais de um minuto vira quanto tempo faz", () => {
    expect(ago(1000 - 4 * 60, 1000)).toBe("há 4m");
    expect(ago(1000 - 96 * 60, 1000)).toBe("há 1h 36m");
  });
});

describe("bytes", () => {
  it("uma casa até dez, nenhuma depois", () => {
    expect(bytes(822 * 1024 * 1024)).toBe("822 MB");
    expect(bytes(1.25 * 1024 * 1024 * 1024)).toBe("1.3 GB");
    expect(bytes(4096)).toBe("4.0 KB");
  });

  it("processo que ainda não pegou memória nenhuma", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(900)).toBe("900 B");
  });
});
