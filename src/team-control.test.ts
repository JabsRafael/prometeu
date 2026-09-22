import { describe, expect, it } from "vitest";
import { remoteControl } from "./team-control";

describe("team remote control", () => {
  it("passes ordinary text through as input", () => {
    expect(remoteControl("pode continuar")).toEqual({ recognized: false, frame: null });
  });

  it("accepts only interruption and bounded responses", () => {
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

  it("discards unknown controls without turning them into prompts", () => {
    expect(remoteControl(JSON.stringify({ v: 1, type: "permission.mode.set", mode: "bypass" })))
      .toEqual({ recognized: true, frame: null });
    expect(remoteControl(JSON.stringify({ type: "control_magic" }))).toEqual({ recognized: true, frame: null });
  });
});
