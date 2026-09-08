import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { use } from "./i18n";
import { updater, view, type Found, type Io, type View } from "./update";

// Pin the tested language because Node defaults to English.
use("pt-BR");

/// A controlled update emits download progress and finishes when the test allows it.
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
  const faces: View[] = [];
  const said: string[] = [];
  const io: Io = {
    check: vi.fn(async () => update),
    relaunch: vi.fn(async () => {}),
    clock: () => "13:48",
    show: (f) => faces.push(f),
    say: (t) => said.push(t),
  };
  return { io, faces, said, last: () => faces[faces.length - 1] };
}

/// Flush download promises with fake timers instead of using setTimeout.
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("view", () => {
  it("cada fase tem o seu texto, e só a pronta é cheia", () => {
    const update = found("0.2.0");
    expect(view({ at: "quiet" })).toMatchObject({ text: "Buscar atualizações", disabled: false });
    expect(view({ at: "checking" })).toMatchObject({ text: "Buscando…", disabled: true });
    expect(view({ at: "found", update })).toMatchObject({ text: "Atualizar para 0.2.0", title: "notas", ready: false });
    expect(view({ at: "downloading", update, got: 0, total: 0 })).toMatchObject({ text: "Baixando…", disabled: true });
    expect(view({ at: "downloading", update, got: 50, total: 200 })).toMatchObject({ text: "Baixando 25%" });
    expect(view({ at: "ready", version: "0.2.0" })).toMatchObject({ text: "Reiniciar para atualizar", ready: true, disabled: false });
    expect(view({ at: "restarting", version: "0.2.0" })).toMatchObject({ text: "Reiniciando…", ready: true, disabled: true });
  });

  it("o rodapé só mostra o botão quando tem o que fazer com ele", () => {
    const update = found("0.2.0");
    expect(view({ at: "quiet" }).footer).toBe(false);
    expect(view({ at: "checking" }).footer).toBe(false);
    expect(view({ at: "fresh", when: "13:48" }).footer).toBe(false);
    expect(view({ at: "failed", why: "offline" }).footer).toBe(false);
    expect(view({ at: "found", update }).footer).toBe(true);
    expect(view({ at: "ready", version: "0.2.0" }).footer).toBe(true);
  });

  it("as notas da versão encontrada viajam até a linha, e só nela", () => {
    const update = found("0.2.0");
    expect(view({ at: "found", update }).notes).toEqual({ version: "0.2.0", body: "notas" });
    // Release-note review ends once downloading starts or the update is ready.
    expect(view({ at: "downloading", update, got: 0, total: 0 }).notes).toBeUndefined();
    expect(view({ at: "ready", version: "0.2.0" }).notes).toBeUndefined();
    // A release without notes must not open an empty dialog.
    expect(view({ at: "found", update: { ...update, body: "  " } }).notes).toBeUndefined();
  });

  it("a linha de Configurações diz a hora da última pergunta e o motivo da falha", () => {
    expect(view({ at: "fresh", when: "13:48" })).toMatchObject({
      text: "Buscar atualizações",
      note: "Nenhuma novidade — conferido às 13:48",
      tone: "plain",
    });
    expect(view({ at: "failed", why: "Error: offline" })).toMatchObject({
      text: "Buscar atualizações",
      note: "Não deu para buscar: Error: offline",
      tone: "bad",
    });
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

    // Regression: the restart button previously did nothing.
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
    expect(w.said[w.said.length - 1]).toMatch(/feche e abra o Prometeu.*0\.2\.0/);
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

  it("depois de achar não pergunta de novo, e sem novidade diz a hora", async () => {
    const w = world(found());
    const up = updater(w.io);
    await up.look();
    await up.look();
    expect(w.io.check).toHaveBeenCalledTimes(1);

    const quiet = world(null);
    const q = updater(quiet.io);
    await q.look();
    expect(q.phase()).toEqual({ at: "fresh", when: "13:48" });
    expect(quiet.last()?.footer).toBe(false);
    expect(quiet.last()?.note).toMatch(/conferido às 13:48/);
  });

  it("clicar sem novidade nenhuma pergunta de novo", async () => {
    const w = world(null);
    const up = updater(w.io);
    await up.look();
    await up.click();
    expect(w.io.check).toHaveBeenCalledTimes(2);
    expect(up.phase().at).toBe("fresh");

    // Manual checks can discover updates before the scheduled check.
    w.io.check = vi.fn(async () => found("0.3.0"));
    await up.click();
    expect(w.last()?.text).toBe("Atualizar para 0.3.0");
  });

  it("erro do relógio é silêncio, erro do seu clique aparece", async () => {
    const w = world(null);
    const up = updater(w.io);
    await up.look();
    const quiet = w.faces.length;

    w.io.check = vi.fn(async () => {
      throw new Error("offline");
    });
    await up.look();
    // Retain the previous status during a background check.
    expect(up.phase()).toEqual({ at: "fresh", when: "13:48" });
    expect(w.said).toEqual([]);
    expect(w.faces.length).toBeGreaterThan(quiet); // Entered the checking state, then returned.

    await up.click();
    expect(up.phase()).toEqual({ at: "failed", why: "Error: offline" });
    expect(w.last()?.note).toMatch(/Não deu para buscar.*offline/);
    // Manual errors belong in Settings, not the sidebar footer.
    expect(w.last()?.footer).toBe(false);
    expect(w.said).toEqual([]);
  });

  it("clicar durante a busca não pergunta duas vezes", async () => {
    const w = world(null);
    let release!: (v: Found | null) => void;
    w.io.check = vi.fn(() => new Promise<Found | null>((r) => (release = r)));
    const up = updater(w.io);
    const first = up.look(true);
    await tick();
    expect(up.phase().at).toBe("checking");
    await up.click();
    expect(w.io.check).toHaveBeenCalledTimes(1);
    release(null);
    await first;
    expect(up.phase().at).toBe("fresh");
  });
});
