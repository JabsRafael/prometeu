import { describe, expect, it } from "vitest";
import { remoteControl } from "./team-control";

describe("controle remoto do time", () => {
  it("deixa texto comum seguir como fala", () => {
    expect(remoteControl("pode continuar")).toEqual({ recognized: false, frame: null });
  });

  it("aceita apenas interrupção e resposta limitada", () => {
    const interrupt = { type: "control_request", request_id: "r1", request: { subtype: "interrupt" } };
    const answer = {
      type: "control_response",
      response: { subtype: "success", request_id: "r2", response: { behavior: "allow" } },
    };
    expect(remoteControl(JSON.stringify(interrupt)).frame).toEqual(interrupt);
    expect(remoteControl(JSON.stringify(answer)).frame).toEqual(answer);
  });

  it("engole controles inventados sem transformá-los em prompt", () => {
    expect(remoteControl(JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "set_permission_mode" } })))
      .toEqual({ recognized: true, frame: null });
    expect(remoteControl(JSON.stringify({ type: "control_magic" }))).toEqual({ recognized: true, frame: null });
  });
});
