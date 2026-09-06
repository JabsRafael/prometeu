import { describe, expect, it } from "vitest";
import { emptyCatalog, initializeDefaults, commandNames, expand, findCommand, type Action } from "./actions";

const prompt: Action = { name: "revisar", kind: "prompt", prompt: "Revise o diff.", description: "", profile: null };
const task: Action = { ...prompt, name: "entregar", kind: "agent", profile: "owner" };
describe("comandos reutilizáveis", () => {
  it("preserva comandos do provider e resolve colisões com namespace explícito", () => {
    const provider = [{ name: "revisar" }];
    expect(commandNames([prompt, task], provider).map(c => c.name)).toEqual(["prometeu:revisar", "entregar"]);
    expect(findCommand("/revisar", [prompt], provider)).toBeNull();
    expect(findCommand("/prometeu:revisar arquivo.ts", [prompt], provider)).toEqual({ action: prompt, rest: "arquivo.ts" });
    expect(findCommand("/entregar contexto\nextra", [task], provider)).toEqual({ action: task, rest: "contexto\nextra" });
  });
  it("expande prompt sem perder texto e não intercepta caminhos ou comandos desconhecidos", () => {
    expect(expand(prompt.prompt, "  arquivo.ts  ")).toBe("Revise o diff.\n\narquivo.ts");
    expect(findCommand("/Users/me/projeto", [prompt], [])).toBeNull();
    expect(findCommand("/compact", [prompt], [])).toBeNull();
    expect(findCommand("texto /revisar", [prompt], [])).toBeNull();
    expect(findCommand("/prometeu:revisar", [prompt], [])?.action).toEqual(prompt);
  });
});


describe("Code review incluído", () => {
  it("inicializa uma vez, preserva personalizações e respeita remoção", () => {
    const seeded = initializeDefaults(emptyCatalog());
    expect(seeded.commands.map(c => c.name)).toEqual(["review"]);
    expect(seeded.profiles[0].watch).toBeNull();
    seeded.profiles[0].choice.model = "sonnet";
    expect(initializeDefaults(seeded).profiles[0].choice.model).toBe("sonnet");
    seeded.commands = []; seeded.profiles = [];
    expect(initializeDefaults(JSON.parse(JSON.stringify(seeded))).commands).toEqual([]);
    const custom = { ...emptyCatalog(), commands: [{ ...prompt, name: "review" }] };
    expect(initializeDefaults(custom).commands).toEqual(custom.commands);
    expect(initializeDefaults(custom).profiles).toEqual([]);
  });
});
