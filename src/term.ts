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

export type Skin = {
  fontSize: number;
  foreground: string;
  scrollback: number;
};

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

  open(host: HTMLElement) {
    this.host = host;
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.term.onData((data) => {
      if (this.key) invoke("pty_write", { session: this.key, data });
    });
    new ResizeObserver(() => this.refit()).observe(host);
    listen<[string, number[]]>("pty", ({ payload: [session, bytes] }) => {
      if (session !== this.key) return;
      this.term.write(this.decoder.decode(new Uint8Array(bytes), { stream: true }));
    });
  }

  /// Troca para outro PTY, redesenhando a rolagem que o back guardou.
  async attach(key: string) {
    this.key = key;
    this.term.reset();
    const buf = await invoke<number[]>("pty_buffer", { session: key });
    this.term.write(new TextDecoder("utf-8").decode(new Uint8Array(buf)));
    this.refit(true);
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
  /// não é.
  refit(force = false) {
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => {
      if (!this.host.clientHeight || !this.host.clientWidth) return;
      const before = `${this.term.cols}x${this.term.rows}`;
      this.fit.fit();
      const changed = `${this.term.cols}x${this.term.rows}` !== before;
      if (this.key && (force || changed)) {
        invoke("pty_resize", { session: this.key, cols: this.term.cols, rows: this.term.rows });
      }
    });
  }
}
