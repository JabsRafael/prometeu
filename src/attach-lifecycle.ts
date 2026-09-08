/// A new remote snapshot attachment cancels and immediately resolves the previous wait so stale continuations cannot change another screen.
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

  /// Only the matching tab's final snapshot chunk completes the current wait.
  completeTab(tab: string): boolean {
    const pending = this.pending;
    if (!pending || pending.tab !== tab) return false;
    this.complete(pending.token);
    return true;
  }

  /// On disconnect, display the available mirror instead of waiting. Only navigation invalidates the ticket.
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
