import { invoke } from "./ipc";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/// An xterm view for backend PTYs; agent conversations use chat.ts.
/// Measure visible hosts on the next frame so layout changes do not clip terminal rows.

export type Skin = {
  fontSize: number;
  foreground: string;
  scrollback: number;
};

/// Route input to the local PTY or its remote owner.
export type Sink = (key: string, data: string) => void;

const BACKGROUND = "#141110";

export class Term {
  private term: Terminal;
  private fit = new FitAddon();
  private decoder = new TextDecoder("utf-8");
  private host!: HTMLElement;
  private pending = 0;
  private attachVersion = 0;
  /// Ignore output from PTYs that are not attached to this view.
  private key: string | null = null;
  private sink: Sink = () => {};

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

  /// Invalidate earlier opens before waiting for the process and its retained output.
  async attach(key: string, ready: Promise<unknown>) {
    this.detach();
    const version = this.attachVersion;
    this.key = key;
    try {
      await ready;
      if (version !== this.attachVersion) return;
      const buf = await invoke("pty_buffer", { session: key });
      if (version !== this.attachVersion) return;
      this.term.write(new TextDecoder("utf-8").decode(new Uint8Array(buf)));
      this.refit(true);
    } catch (error) {
      if (version !== this.attachVersion) return;
      this.detach();
      throw error;
    }
  }

  /// Show retained output without attaching input to an exited process.
  async show(key: string) {
    this.detach();
    const version = this.attachVersion;
    const buf = await invoke("pty_buffer", { session: key });
    if (version !== this.attachVersion) return;
    this.term.write(new TextDecoder("utf-8").decode(new Uint8Array(buf)));
    this.refit();
  }

  detach() {
    this.attachVersion++;
    this.key = null;
    this.decoder = new TextDecoder("utf-8");
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

  /// Force a resize after switching PTYs even when the view dimensions stay the same.
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
