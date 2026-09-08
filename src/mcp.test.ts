import { describe, expect, it } from "vitest";
import { toDraft, toServer, type Draft } from "./mcp";

/// Translate editable form fields into the provider configuration shape.
describe("o formulário e o cadastro", () => {
  it("o comando digitado vira programa e argumentos", () => {
    const server = toServer({
      stdio: true,
      id: " eco ",
      cmd: "  npx -y @modelcontextprotocol/server-everything  ",
      url: "",
      pairs: [],
      note: " o de teste ",
    });
    expect(server).toEqual({
      id: "eco",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        env: {},
      },
      note: "o de teste",
    });
  });

  /// The same key/value entry becomes a local environment variable or a remote header depending on transport.
  it("os pares viram variável no stdio e cabeçalho no remoto", () => {
    const pairs: [string, string][] = [["X-Key", "abracadabra"]];
    const aqui = toServer({ stdio: true, id: "aqui", cmd: "node s.js", url: "", pairs, note: "" });
    expect(aqui!.config.env).toEqual({ "X-Key": "abracadabra" });
    const la = toServer({ stdio: false, id: "la", cmd: "", url: "https://x/mcp", pairs, note: "" });
    expect(la!.config.headers).toEqual({ "X-Key": "abracadabra" });
    expect(la!.config.url).toBe("https://x/mcp");
  });

  /// Ignore newly added blank rows instead of creating variables with empty names.
  it("par sem nome não entra no cadastro", () => {
    const server = toServer({
      stdio: true,
      id: "x",
      cmd: "node s.js",
      url: "",
      pairs: [
        ["", "sobrou"],
        [" TOKEN ", " abc "],
      ],
      note: "",
    });
    expect(server!.config.env).toEqual({ TOKEN: "abc" });
  });

  it("sem nome, ou sem o endereço do tipo escolhido, não há o que gravar", () => {
    const base: Draft = { stdio: false, id: "", cmd: "node s.js", url: "https://x", pairs: [], note: "" };
    expect(toServer(base)).toBeNull();
    expect(toServer({ ...base, id: "x", url: "" })).toBeNull();
    // Ignore empty fields belonging to the other transport type.
    expect(toServer({ ...base, id: "x", cmd: "" })).not.toBeNull();
  });

  it("um servidor cadastrado volta ao formulário como foi digitado", () => {
    const server = {
      id: "capim-ds",
      config: { type: "stdio", command: "npx", args: ["-y", "@capim/ds-mcp"], env: { TOKEN: "abc" } },
      note: "design system",
    };
    const draft = toDraft(server);
    expect(draft.stdio).toBe(true);
    expect(draft.cmd).toBe("npx -y @capim/ds-mcp");
    expect(draft.pairs).toEqual([["TOKEN", "abc"]]);
    expect(toServer(draft)).toEqual(server);
  });

  it("um remoto volta com a URL e os cabeçalhos no mesmo lugar", () => {
    const draft = toDraft({
      id: "notion",
      config: { type: "http", url: "https://mcp.notion.com/mcp", headers: { "X-Id": "7" } },
      note: "",
    });
    expect(draft.stdio).toBe(false);
    expect(draft.url).toBe("https://mcp.notion.com/mcp");
    expect(draft.pairs).toEqual([["X-Id", "7"]]);
  });

  it("o formulário em branco começa como um programa daqui", () => {
    expect(toDraft(null)).toEqual({ stdio: true, id: "", cmd: "", url: "", pairs: [], note: "" });
  });
});
