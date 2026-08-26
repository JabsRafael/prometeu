import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/// Um terminal ligado a um PTY do back. A conversa e o dock são os dois, e
/// antes cada um trazia a sua cópia de tudo: abrir, ligar o `onData`, escutar o
/// evento `pty`, remedir no resize, reidratar a rolagem. Igual nos dois, com as
/// diferenças que importam (fonte, cor, scrollback) perdidas no meio.
///
/// A medida é o ponto frágil: se a conta roda com a view ainda escondida, ou
/// antes de a barra assentar, sobram linhas e a última fica cortada na borda de
/// baixo. Daí esperar o próximo quadro e só medir quando o elemento tem tamanho.
///
/// A conversa de um colega passa por aqui também, só que ao contrário: os
/// bytes vêm do relay (`remoteWrite`) e não do evento `pty`, as teclas vão
/// para o link e não para o `pty_write` — quem decide é o `sink` —, e o
/// tamanho é o do terminal dele, não o desta janela (`attachRemote`).

export type Skin = {
  fontSize: number;
  foreground: string;
  scrollback: number;
};

/// Para onde vão as teclas de uma chave: o PTY local, ou o dono do lado de lá.
export type Sink = (key: string, data: string) => void;

const BACKGROUND = "#141110";

export class Term {
  private term: Terminal;
  private fit = new FitAddon();
  private decoder = new TextDecoder("utf-8");
  private host!: HTMLElement;
  private pending = 0;
  /// Qual PTY está na tela. Os outros seguem rodando por trás — o back manda a
  /// saída de todos, e o que não é daqui é descartado.
  private key: string | null = null;
  /// Tamanho ditado pelo outro lado: a conversa de um colega tem as colunas e
  /// linhas do terminal dele. Sem FitAddon e sem `pty_resize` enquanto durar.
  private fixed: { cols: number; rows: number } | null = null;
  private sink: Sink = () => {};
  private resized: ((key: string, cols: number, rows: number) => void) | null = null;

  constructor(skin: Skin) {
    this.term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: skin.fontSize,
      theme: {
        background: BACKGROUND,
        foreground: skin.foreground,
        cursor: "#d8c2b3",
        selectionBackground: "#373533",
      },
      allowProposedApi: true,
      scrollback: skin.scrollback,
    });
  }

  open(host: HTMLElement, sink: Sink) {
    this.host = host;
    this.sink = sink;
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.term.onData((data) => {
      if (this.key) this.sink(this.key, data);
    });
    new ResizeObserver(() => this.refit()).observe(host);
    listen<[string, number[], number]>("pty", ({ payload: [session, bytes] }) => {
      if (session !== this.key) return;
      this.term.write(this.decoder.decode(new Uint8Array(bytes), { stream: true }));
    });
  }

  /// Troca para outro PTY, redesenhando a rolagem que o back guardou.
  async attach(key: string) {
    this.key = key;
    this.fix(null);
    this.term.reset();
    const buf = await invoke<number[]>("pty_buffer", { session: key });
    this.term.write(new TextDecoder("utf-8").decode(new Uint8Array(buf)));
    this.refit(true);
  }

  /// A conversa de um colega: a rolagem que veio dele, no tamanho dele. Daqui
  /// em diante os bytes chegam por `remoteWrite`, e o tamanho por `setSize`.
  attachRemote(key: string, bytes: Uint8Array, cols: number, rows: number) {
    this.key = key;
    this.term.reset();
    this.fix({ cols, rows });
    this.term.write(new TextDecoder("utf-8").decode(bytes));
  }

  /// Saída ao vivo de uma conversa remota. O que não é da chave na tela é
  /// descartado — o link guarda o espelho de cada aba, e é dele que a tela
  /// renasce ao trocar.
  remoteWrite(key: string, bytes: Uint8Array) {
    if (key !== this.key) return;
    this.term.write(this.decoder.decode(bytes, { stream: true }));
  }

  /// O dono redimensionou: a tela daqui acompanha.
  setSize(cols: number, rows: number) {
    if (this.fixed) this.fix({ cols, rows });
  }

  private fix(size: { cols: number; rows: number } | null) {
    this.fixed = size;
    // Terminal maior que o painel rola em vez de cortar.
    this.host.classList.toggle("fixed", size !== null);
    if (size) this.term.resize(size.cols, size.rows);
  }

  /// Só a rolagem de um pty, sem se ligar a ele: o que sobrou de um processo
  /// que já morreu. Não aceita tecla — não há para quem mandar.
  async show(key: string) {
    this.detach();
    const buf = await invoke<number[]>("pty_buffer", { session: key });
    this.term.write(new TextDecoder("utf-8").decode(new Uint8Array(buf)));
    this.refit();
  }

  detach() {
    this.key = null;
    this.fix(null);
    this.term.reset();
  }

  current() {
    return this.key;
  }

  focus() {
    this.term.focus();
  }

  dims() {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /// Avisa o PTY do tamanho novo. `force` manda mesmo sem ter mudado, que é o
  /// caso de trocar de sessão: o tamanho é o mesmo, o processo do outro lado
  /// não é. Com tamanho fixo não há o que medir: quem manda é o outro lado.
  refit(force = false) {
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => {
      if (this.fixed || !this.host.clientHeight || !this.host.clientWidth) return;
      const before = `${this.term.cols}x${this.term.rows}`;
      this.fit.fit();
      const changed = `${this.term.cols}x${this.term.rows}` !== before;
      if (this.key && (force || changed)) {
        invoke("pty_resize", { session: this.key, cols: this.term.cols, rows: this.term.rows });
        this.resized?.(this.key, this.term.cols, this.term.rows);
      }
    });
  }

  /// Quem quer saber o tamanho que cada PTY ganhou — o compartilhamento, que
  /// conta ao colega em que tamanho desenhar.
  onResize(cb: (key: string, cols: number, rows: number) => void) {
    this.resized = cb;
  }

  /// Teclas que o app quer antes do terminal. Devolver `false` come a tecla.
  onKey(handler: (e: KeyboardEvent) => boolean) {
    this.term.attachCustomKeyEventHandler(handler);
  }

  /// O texto selecionado com o mouse, como o xterm o vê — é o que uma nota
  /// cita.
  selection() {
    return this.term.getSelection();
  }

  onSelection(cb: (has: boolean) => void) {
    this.term.onSelectionChange(() => cb(this.term.hasSelection()));
  }
}
