import { describe, expect, it } from "vitest";
import { freshBranch, stamp } from "./branch";

const at = (iso: string) => new Date(iso);

describe("stamp", () => {
  it("leva o dia junto do horário", () => {
    expect(stamp(at("2026-08-30T15:08:00"))).toBe("0830-1508");
  });

  it("preenche com zero o mês, o dia e a hora", () => {
    expect(stamp(at("2026-01-02T03:04:00"))).toBe("0102-0304");
  });
});

describe("freshBranch", () => {
  it("o mesmo horário de outro dia não é o mesmo nome", () => {
    const hoje = freshBranch([], at("2026-08-30T15:08:00"));
    const antes = freshBranch([], at("2026-08-12T15:08:00"));
    expect(hoje).toBe("prometheus/0830-1508");
    expect(hoje).not.toBe(antes);
  });

  it("nome de branch que já existe no repo não é oferecido de novo", () => {
    const taken = ["prometheus/0830-1508", "main"];
    expect(freshBranch(taken, at("2026-08-30T15:08:00"))).toBe(
      "prometheus/0830-1508-2",
    );
  });

  it("branch só no remoto também conta como tomada", () => {
    const taken = [
      "origin/prometheus/0830-1508",
      "origin/prometheus/0830-1508-2",
    ];
    expect(freshBranch(taken, at("2026-08-30T15:08:00"))).toBe(
      "prometheus/0830-1508-3",
    );
  });

  it("nome parecido de outro projeto não atrapalha", () => {
    const taken = ["outro-prometheus/0830-1508", "prometheus/0830-1509"];
    expect(freshBranch(taken, at("2026-08-30T15:08:00"))).toBe(
      "prometheus/0830-1508",
    );
  });
});
