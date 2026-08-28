import { describe, expect, it } from "vitest";
import { empty, hydrate, reduce, type Effect, type Event, type State } from "./logic";
import { encodeLive, encodeSnapshot, type Down, type Share, type Up } from "./protocol";

const NOW = 1_700_000_000_000;

const open = (sock: string, member: string, name = member): Event => ({ k: "open", sock, member, name, now: NOW });
const close = (sock: string): Event => ({ k: "close", sock, now: NOW + 1 });
const text = (sock: string, frame: Up, rand = "r"): Event => ({ k: "text", sock, frame, now: NOW + 2, rand });
const binary = (sock: string, data: Uint8Array): Event => ({ k: "binary", sock, data });

const share = (id = "ws1", tabs = ["t1", "t2"], audience: string[] | null = null): Share => ({
  id,
  title: "Ícone do app",
  repo_name: "prometheus",
  branch: "prometheus/1606",
  stage: "Fazendo",
  issue: null,
  active: tabs[0] ?? null,
  tabs: tabs.map((t) => ({ id: t, title: t, status: "rodando", note: null, tokens: null })),
  sizes: {},
  audience,
});

const sent = (fx: Effect[], sock: string) =>
  fx.filter((f): f is Extract<Effect, { e: "send" }> => f.e === "send" && f.sock === sock).map((f) => f.frame);
const kinds = (fx: Effect[], sock: string) => sent(fx, sock).map((f) => f.t);
const one = <T extends Down["t"]>(fx: Effect[], sock: string, t: T) =>
  sent(fx, sock).find((f): f is Extract<Down, { t: T }> => f.t === t);
const puts = (fx: Effect[]) => fx.filter((f) => f.e === "put").map((f) => (f as Extract<Effect, { e: "put" }>).key);
const dels = (fx: Effect[]) => fx.filter((f) => f.e === "del").map((f) => (f as Extract<Effect, { e: "del" }>).key);

/// Alice e Bob conectados, Alice compartilhando `ws1`.
function team(): State {
  const s = empty();
  reduce(s, open("a1", "alice"));
  reduce(s, open("b1", "bob"));
  reduce(s, text("a1", { t: "share", share: share() }));
  return s;
}

describe("presença", () => {
  it("quem entra recebe welcome e os outros recebem presence", () => {
    const s = empty();
    const first = reduce(s, open("a1", "alice"));
    expect(kinds(first, "a1")).toEqual(["welcome"]);
    expect(one(first, "a1", "welcome")!.members).toEqual([{ id: "alice", name: "alice", online: true }]);
    expect(puts(first)).toEqual(["member:alice"]);

    const second = reduce(s, open("b1", "bob", "Bob"));
    expect(kinds(second, "a1")).toEqual(["presence"]);
    expect(one(second, "b1", "welcome")!.members.map((m) => m.name)).toEqual(["alice", "Bob"]);
  });

  it("nome vazio na conexão mantém o que o membro já tinha", () => {
    const s = empty();
    reduce(s, open("a1", "alice", "Alice"));
    reduce(s, close("a1"));
    const fx = reduce(s, open("a2", "alice", ""));
    expect(one(fx, "a2", "welcome")!.members[0].name).toBe("Alice");
  });

  it("fechar o último socket do membro deixa ele offline, mas na lista", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    const fx = reduce(s, close("b1"));
    expect(one(fx, "a1", "presence")!.members).toEqual([
      { id: "alice", name: "alice", online: true },
      { id: "bob", name: "bob", online: false },
    ]);
  });

  it("me troca o nome e avisa todo mundo", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    const fx = reduce(s, text("b1", { t: "me", name: "Roberto" }));
    expect(one(fx, "a1", "presence")!.members[1].name).toBe("Roberto");
    expect(puts(fx)).toEqual(["member:bob"]);
  });
});

describe("compartilhar e olhar", () => {
  it("share vai para todos com o dono e online; attach avisa o dono quem chegou", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    const fx = reduce(s, text("a1", { t: "share", share: share() }));
    const got = one(fx, "b1", "share")!;
    expect(got.share.owner).toBe("alice");
    expect(got.share.online).toBe(true);
    expect(puts(fx)).toEqual(["share:ws1"]);

    const at = reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    expect(at).toContainEqual({ e: "attachment", sock: "b1", member: "bob", attached: { ws: "ws1", tab: "t1" } });
    expect(one(at, "a1", "watch")).toEqual({ t: "watch", ws: "ws1", tab: "t1", members: ["bob"], added: ["bob"] });
  });

  it("bytes ao vivo só chegam a quem olha a aba, e nunca voltam ao dono", () => {
    const s = team();
    reduce(s, open("c1", "carol"));
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    reduce(s, text("c1", { t: "attach", ws: "ws1", tab: "t2" }));
    const data = encodeLive("t1", [{ seq: 1, bytes: new Uint8Array([1, 2, 3]) }]);
    const fx = reduce(s, binary("a1", data));
    expect(fx).toEqual([{ e: "sendBinary", sock: "b1", data }]);
  });

  it("snapshot vai só para quem foi endereçado", () => {
    const s = team();
    reduce(s, open("c1", "carol"));
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    reduce(s, text("c1", { t: "attach", ws: "ws1", tab: "t1" }));
    const data = encodeSnapshot("t1", "carol", 7, new Uint8Array([9]));
    expect(reduce(s, binary("a1", data))).toEqual([{ e: "sendBinary", sock: "c1", data }]);
  });

  it("quem não é o dono não transmite nada", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    expect(reduce(s, binary("b1", encodeLive("t1", [{ seq: 1, bytes: new Uint8Array([1]) }])))).toEqual([]);
  });

  it("trocar de aba solta a anterior e o dono ouve as duas", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t2" }));
    expect(sent(fx, "a1")).toEqual([
      { t: "watch", ws: "ws1", tab: "t1", members: [], added: [] },
      { t: "watch", ws: "ws1", tab: "t2", members: ["bob"], added: ["bob"] },
    ]);
    const off = reduce(s, text("b1", { t: "detach" }));
    expect(one(off, "a1", "watch")).toEqual({ t: "watch", ws: "ws1", tab: "t2", members: [], added: [] });
  });

  it("attach em workspace ou aba que não existe é erro", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "attach", ws: "nada", tab: "t1" })), "b1", "error")!.code).toBe("noShare");
    expect(one(reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t9" })), "b1", "error")!.code).toBe("noTab");
  });

  it("write chega ao dono com quem escreveu; dono offline é erro", () => {
    const s = team();
    const fx = reduce(s, text("b1", { t: "write", ws: "ws1", tab: "t1", data: "ls\r" }));
    expect(sent(fx, "a1")).toEqual([{ t: "write", ws: "ws1", tab: "t1", data: "ls\r", from: "bob" }]);
    reduce(s, close("a1"));
    const off = reduce(s, text("b1", { t: "write", ws: "ws1", tab: "t1", data: "x" }));
    expect(one(off, "b1", "error")!.code).toBe("offline");
  });

  it("size do dono vai a quem olha a aba e fica no share", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("a1", { t: "size", ws: "ws1", tab: "t1", cols: 120, rows: 40 }));
    expect(sent(fx, "b1")).toEqual([{ t: "size", ws: "ws1", tab: "t1", cols: 120, rows: 40 }]);
    expect(s.shares.get("ws1")!.share.sizes.t1).toEqual([120, 40]);
  });

  it("dono cai: share fica offline para todos; volta e reanuncia: online, e sabe quem já olhava", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const gone = reduce(s, close("a1"));
    const got = one(gone, "b1", "share")!;
    expect(got.share.online).toBe(false);
    expect(puts(gone)).toContain("share:ws1");

    // Voltar já põe o share de pé — e avisa quem estava olhando —, sem
    // esperar o dono reanunciar: o terminal volta a andar na mesma hora.
    const back = reduce(s, open("a2", "alice"));
    const welcome = one(back, "a2", "welcome")!;
    expect(welcome.shares[0].online).toBe(true);
    expect(welcome.watching).toEqual({ ws1: { t1: ["bob"] } });
    expect(one(back, "b1", "share")!.share.online).toBe(true);
    expect(puts(back)).toContain("share:ws1");
    // Reanunciar depois não repete o aviso à toa.
    const again = reduce(s, text("a2", { t: "share", share: share() }));
    expect(one(again, "b1", "share")!.share.online).toBe(true);
  });

  it("unshare solta quem olhava e some da lista", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("a1", { t: "unshare", ws: "ws1" }));
    expect(dels(fx)).toEqual(["share:ws1"]);
    expect(fx).toContainEqual({ e: "attachment", sock: "b1", member: "bob", attached: null });
    expect(kinds(fx, "b1")).toEqual(["unshare"]);
    expect(s.shares.size).toBe(0);
  });

  it("só o dono mexe no próprio share", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "share", share: share() })), "b1", "error")!.code).toBe("owner");
    expect(one(reduce(s, text("b1", { t: "unshare", ws: "ws1" })), "b1", "error")!.code).toBe("owner");
  });
});

describe("audiência", () => {
  /// Alice, Bob e Carol conectados; Alice compartilha `ws1` só com Bob.
  function trio(): State {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    reduce(s, open("c1", "carol"));
    reduce(s, text("a1", { t: "share", share: share("ws1", ["t1", "t2"], ["bob"]) }));
    return s;
  }

  it("share só chega a quem está na lista; para o resto o workspace não existe", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    reduce(s, open("c1", "carol"));
    const fx = reduce(s, text("a1", { t: "share", share: share("ws1", ["t1"], ["bob"]) }));
    expect(kinds(fx, "a1")).toEqual(["share"]);
    expect(kinds(fx, "b1")).toEqual(["share"]);
    expect(kinds(fx, "c1")).toEqual([]);
    expect(one(reduce(s, text("c1", { t: "attach", ws: "ws1", tab: "t1" })), "c1", "error")!.code).toBe("noShare");
    expect(one(reduce(s, text("c1", { t: "write", ws: "ws1", tab: "t1", data: "x" })), "c1", "error")!.code).toBe("noShare");
    expect(one(reduce(s, text("c1", { t: "notes", ws: "ws1" })), "c1", "error")!.code).toBe("noShare");
    expect(kinds(reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" })), "b1")).toEqual([]);
  });

  it("welcome só traz o que quem chega vê; dono sempre vê o seu", () => {
    const s = trio();
    reduce(s, close("c1"));
    expect(one(reduce(s, open("c2", "carol")), "c2", "welcome")!.shares).toEqual([]);
    reduce(s, close("a1"));
    expect(one(reduce(s, open("a2", "alice")), "a2", "welcome")!.shares.map((x) => x.id)).toEqual(["ws1"]);
  });

  it("dono cai e volta: só a audiência ouve o offline e o online", () => {
    const s = trio();
    const down = reduce(s, close("a1"));
    expect(kinds(down, "b1")).toEqual(["share", "presence"]);
    expect(kinds(down, "c1")).toEqual(["presence"]);
    const up = reduce(s, open("a2", "alice"));
    expect(kinds(up, "b1")).toEqual(["share", "presence"]);
    expect(kinds(up, "c1")).toEqual(["presence"]);
  });

  it("tirar alguém da lista: ele recebe unshare e solta a aba; entrar na lista: recebe share", () => {
    const s = trio();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("a1", { t: "share", share: share("ws1", ["t1", "t2"], ["carol"]) }));
    expect(kinds(fx, "b1")).toEqual(["unshare"]);
    expect(fx).toContainEqual({ e: "attachment", sock: "b1", member: "bob", attached: null });
    expect(kinds(fx, "c1")).toEqual(["share"]);
    expect(one(fx, "a1", "watch")).toEqual({ t: "watch", ws: "ws1", tab: "t1", members: [], added: [] });
    expect(s.socks.get("b1")!.attached).toBeNull();
  });

  it("abrir para o time inteiro: todos recebem share; unshare vai só a quem via", () => {
    const s = trio();
    const all = reduce(s, text("a1", { t: "share", share: share("ws1", ["t1"], null) }));
    expect(kinds(all, "c1")).toEqual(["share"]);
    reduce(s, text("a1", { t: "share", share: share("ws1", ["t1"], ["bob"]) }));
    const off = reduce(s, text("a1", { t: "unshare", ws: "ws1" }));
    expect(kinds(off, "b1")).toEqual(["unshare"]);
    expect(kinds(off, "c1")).toEqual([]);
  });

  it("nota fica na audiência, e menção a quem está fora é descartada", () => {
    const s = trio();
    const fx = reduce(s, text("b1", { t: "note", ws: "ws1", text: "@carol @alice", mentions: ["carol", "alice"], quote: null }));
    expect(kinds(fx, "a1")).toEqual(["note", "inbox"]);
    expect(kinds(fx, "b1")).toEqual(["note"]);
    expect(kinds(fx, "c1")).toEqual([]);
    expect(one(fx, "a1", "note")!.note.mentions).toEqual(["alice"]);
    expect(one(reduce(s, text("c1", { t: "note", ws: "ws1", text: "oi", mentions: [], quote: null })), "c1", "error")!.code).toBe("noShare");
  });

  it("share de cliente sem o campo é para o time inteiro, como era", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("c1", "carol"));
    const { audience: _, ...old } = share("ws1", ["t1"]);
    const fx = reduce(s, text("a1", { t: "share", share: old as Share }));
    expect(one(fx, "c1", "share")!.share.audience).toBeNull();
  });
});

describe("notas", () => {
  it("nota vai a todos; a menção vira item na caixa de quem foi citado", () => {
    const s = team();
    const fx = reduce(s, text("b1", { t: "note", ws: "ws1", text: "@alice isso está certo?", mentions: ["alice", "bob", "zé"], quote: "  ✓ 3 tests" }, "abc"));
    const note = one(fx, "a1", "note")!.note;
    expect(note).toMatchObject({ id: `${NOW + 2}-abc`, ws: "ws1", author: "bob", mentions: ["alice"], quote: "  ✓ 3 tests" });
    expect(one(fx, "b1", "note")!.note).toEqual(note);
    expect(one(fx, "a1", "inbox")!.items).toEqual([{ id: note.id, ws: "ws1", author: "bob", ts: NOW + 2 }]);
    expect(one(fx, "b1", "inbox")).toBeUndefined();
    expect(puts(fx)).toEqual([`note:ws1:${note.id}`, `inbox:alice:${note.id}`]);

    const read = reduce(s, text("a1", { t: "inbox_read", id: note.id }));
    expect(dels(read)).toEqual([`inbox:alice:${note.id}`]);
    expect(one(read, "a1", "inbox")!.items).toEqual([]);
  });

  it("nota vazia ou grande demais é recusada", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "note", ws: "ws1", text: "   ", mentions: [], quote: null })), "b1", "error")!.code).toBe("empty");
    expect(one(reduce(s, text("b1", { t: "note", ws: "ws1", text: "x".repeat(9000), mentions: [], quote: null })), "b1", "error")!.code).toBe("tooBig");
  });

  it("notes devolve a lista do workspace, e quem está offline recebe a caixa ao entrar", () => {
    const s = team();
    reduce(s, open("c1", "carol"));
    reduce(s, close("c1"));
    reduce(s, text("b1", { t: "note", ws: "ws1", text: "@carol olha isso", mentions: ["carol"], quote: null }, "n1"));
    reduce(s, text("a1", { t: "note", ws: "ws1", text: "vi", mentions: [], quote: null }, "n2"));
    const list = one(reduce(s, text("b1", { t: "notes", ws: "ws1" })), "b1", "notes")!;
    expect(list.items.map((n) => n.text)).toEqual(["@carol olha isso", "vi"]);
    const back = reduce(s, open("c2", "carol"));
    expect(one(back, "c2", "welcome")!.inbox.map((i) => i.id)).toEqual([`${NOW + 2}-n1`]);
  });
});

describe("dono que volta", () => {
  it("só os shares dele acordam — o do colega continua como estava", () => {
    const s = team();
    reduce(s, text("b1", { t: "share", share: share("ws2", ["u1"]) }));
    reduce(s, close("a1"));
    reduce(s, close("b1"));
    const back = reduce(s, open("a2", "alice"));
    const welcome = one(back, "a2", "welcome")!;
    expect(welcome.shares.map((x) => [x.id, x.online])).toEqual([
      ["ws1", true],
      ["ws2", false],
    ]);
  });
});

describe("acordar do storage", () => {
  it("reconstrói membros, shares, notas e caixas — e share sem dono conectado nasce offline", () => {
    const s = team();
    reduce(s, text("b1", { t: "note", ws: "ws1", text: "@alice oi", mentions: ["alice"], quote: null }, "n1"));
    const rows: [string, unknown][] = [];
    // O que os efeitos gravaram, na forma em que o storage devolveria.
    rows.push(["member:alice", { id: "alice", name: "alice", last_seen: NOW }]);
    rows.push(["member:bob", { id: "bob", name: "bob", last_seen: NOW }]);
    rows.push(["share:ws1", s.shares.get("ws1")]);
    rows.push([`note:ws1:${NOW + 2}-n1`, s.notes.get("ws1")![0]]);
    rows.push([`inbox:alice:${NOW + 2}-n1`, s.inbox.get("alice")![0]]);

    const woke = hydrate(rows, [{ id: "b9", member: "bob", attached: { ws: "ws1", tab: "t1" } }]);
    expect(woke.shares.get("ws1")!.online).toBe(false);
    expect(woke.notes.get("ws1")!.length).toBe(1);
    expect(woke.inbox.get("alice")!.length).toBe(1);
    const fx = reduce(woke, open("a9", "alice"));
    const welcome = one(fx, "a9", "welcome")!;
    expect(welcome.members.map((m) => [m.id, m.online])).toEqual([["alice", true], ["bob", true]]);
    expect(welcome.watching).toEqual({ ws1: { t1: ["bob"] } });
    expect(welcome.inbox.length).toBe(1);
  });
});
