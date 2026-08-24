import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { use } from "./i18n";
import { face, updater, type Face, type Found, type Io } from "./update";

// Fora do navegador o app cai no inglês; estes testes conferem o texto, então
// fixam o idioma em que ele foi escrito.
use("pt-BR");

/// Uma atualização de mentira: o download dispara os eventos de progresso e
/// termina quando o teste mandar.
function found(version = "0.2.0"): Found & { finish: () => void; fail: (why: string) => void; downloads: number } {
  let done!: (v: void) => void;
  let broke!: (e: Error) => void;
  const it = {
    version,
    body: "notas",
    downloads: 0,
    finish: () => done(),
    fail: (why: string) => broke(new Error(why)),
    downloadAndInstall: vi.fn(async (onEvent?: (e: any) => void) => {
      it.downloads++;
      onEvent?.({ event: "Started", data: { contentLength: 200 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 50 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 50 } });
      await new Promise<void>((resolve, reject) => {
        done = resolve;
        broke = reject;
      });
    }),
  };
  return it;
}

function world(update: Found | null) {
  const faces: Face[] = [];
  const said: string[] = [];
  const io: Io = {
    check: vi.fn(async () => update),
    relaunch: vi.fn(async () => {}),
    show: (f) => faces.push(f),
    say: (t) => said.push(t),
  };
  return { io, faces, said, last: () => faces[faces.length - 1] };
}

/// Deixa as promessas do download andarem; com os timers falsos, `setTimeout` não serve.
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("face", () => {
  it("cada fase tem o seu texto, e só a pronta é cheia", () => {
    const update = found("0.2.0");
    expect(face({ at: "quiet" })).toBeNull();
    expect(face({ at: "found", update })).toMatchObject({ text: "Atualizar para 0.2.0", title: "notas", ready: false });
    expect(face({ at: "downloading", update, got: 0, total: 0 })).toMatchObject({ text: "Baixando…", disabled: true });
    expect(face({ at: "downloading", update, got: 50, total: 200 })).toMatchObject({ text: "Baixando 25%" });
    expect(face({ at: "ready", version: "0.2.0" })).toMatchObject({ text: "Reiniciar para atualizar", ready: true, disabled: false });
    expect(face({ at: "restarting", version: "0.2.0" })).toMatchObject({ text: "Reiniciando…", ready: true, disabled: true });
  });
});

describe("updater", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("achar, baixar, e o segundo clique reinicia de verdade", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);

    await up.look();
    expect(w.last()?.text).toBe("Atualizar para 0.2.0");

    const first = up.click();
    await tick();
    expect(w.last()?.text).toBe("Baixando 50%");
    update.finish();
    await first;
    expect(w.last()).toMatchObject({ text: "Reiniciar para atualizar", ready: true });

    // O bug: o clique de reiniciar não fazia nada.
    void up.click();
    await tick();
    expect(w.io.relaunch).toHaveBeenCalledTimes(1);
    expect(w.last()).toMatchObject({ text: "Reiniciando…", disabled: true });
  });

  it("clicar durante o download não baixa duas vezes", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    await up.click();
    expect(update.downloads).toBe(1);
    update.finish();
    await first;
  });

  it("download que falha volta ao botão de atualizar e avisa", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    update.fail("sem rede");
    await first;
    expect(w.last()?.text).toBe("Atualizar para 0.2.0");
    expect(w.said[0]).toMatch(/não deu para atualizar.*sem rede/);
  });

  it("reinício que não acontece avisa para fechar e abrir", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    update.finish();
    await first;

    const second = up.click();
    await vi.advanceTimersByTimeAsync(9_000);
    await second;
    expect(w.last()).toMatchObject({ text: "Reiniciar para atualizar", disabled: false });
    expect(w.said[w.said.length - 1]).toMatch(/feche e abra o Prometheus.*0\.2\.0/);
  });

  it("reinício que o back recusa avisa o erro", async () => {
    const update = found();
    const w = world(update);
    w.io.relaunch = vi.fn(async () => {
      throw "process.restart not allowed";
    });
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    update.finish();
    await first;
    await up.click();
    expect(w.last()?.text).toBe("Reiniciar para atualizar");
    expect(w.said[w.said.length - 1]).toMatch(/não deu para reiniciar: process\.restart not allowed/);
  });

  it("depois de achar não pergunta de novo, e sem novidade não mostra nada", async () => {
    const w = world(found());
    const up = updater(w.io);
    await up.look();
    await up.look();
    expect(w.io.check).toHaveBeenCalledTimes(1);

    const quiet = world(null);
    await updater(quiet.io).look();
    expect(quiet.faces).toEqual([]);
  });

  it("erro ao perguntar é silêncio", async () => {
    const w = world(null);
    w.io.check = vi.fn(async () => {
      throw new Error("offline");
    });
    const up = updater(w.io);
    await up.look();
    expect(w.faces).toEqual([]);
    expect(w.said).toEqual([]);
    expect(up.phase().at).toBe("quiet");
  });
});
