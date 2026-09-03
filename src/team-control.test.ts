import { describe, expect, it } from "vitest";
import { remoteControl } from "./team-control";

describe("controle remoto do time", () => {
  it("deixa texto comum seguir como fala", () => {
    expect(remoteControl("pode continuar")).toEqual({ recognized: false, frame: null });
  });

  it("aceita apenas interrupção e resposta limitada", () => {
    const interrupt = { v: 1, type: "turn.interrupt" };
    const answer = {
      v: 1,
      type: "request.respond",
      requestId: "r2",
      response: { outcome: "allow" },
    };
    expect(remoteControl(JSON.stringify(interrupt)).frame).toEqual(interrupt);
    expect(remoteControl(JSON.stringify(answer)).frame).toEqual(answer);
  });

  it("engole controles inventados sem transformá-los em prompt", () => {
    expect(remoteControl(JSON.stringify({ v: 1, type: "permission.mode.set", mode: "bypass" })))
      .toEqual({ recognized: true, frame: null });
    expect(remoteControl(JSON.stringify({ type: "control_magic" }))).toEqual({ recognized: true, frame: null });
  });
});
