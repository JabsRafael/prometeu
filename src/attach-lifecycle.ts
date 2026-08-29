/// Ciclo de vida de uma espera por snapshot remoto. Uma navegação nova cancela
/// a anterior e, sobretudo, resolve sua Promise na hora: deixar o timer de dez
/// segundos vivo era o que permitia a continuação antiga atravessar de tela.
export type AttachTicket = {
  token: number;
  ws: string;
  tab: string;
  wait: Promise<void>;
};

type Pending = AttachTicket & { resolve: () => void; timer: ReturnType<typeof setTimeout> };

export class AttachLifecycle {
  private serial = 0;
  private pending: Pending | null = null;

  start(ws: string, tab: string, timeout: number): AttachTicket {
    this.cancel();
    const token = ++this.serial;
    let resolve!: () => void;
    const wait = new Promise<void>((done) => (resolve = done));
    const ticket: Pending = {
      token,
      ws,
      tab,
      wait,
      resolve,
      timer: setTimeout(() => this.complete(token), timeout),
    };
    this.pending = ticket;
    return ticket;
  }

  /// A última parte do snapshot chegou. Snapshot atrasado de outra aba não
  /// solta a espera atual.
  completeTab(tab: string): boolean {
    const pending = this.pending;
    if (!pending || pending.tab !== tab) return false;
    this.complete(pending.token);
    return true;
  }

  /// A conexão caiu: o que já existe no espelho é melhor que manter a tela
  /// esperando. O ticket continua válido; só uma navegação o invalida.
  completeCurrent() {
    if (this.pending) this.complete(this.pending.token);
  }

  cancel() {
    this.serial++;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  current(ticket: AttachTicket): boolean {
    return ticket.token === this.serial;
  }

  private complete(token: number) {
    const pending = this.pending;
    if (!pending || pending.token !== token) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }
}
