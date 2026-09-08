/// Merge chunked remote snapshots with live numbered lines without network or DOM dependencies. Lines at or below the snapshot sequence are already included; sequence numbers decide overlap.

/// Match the backend KEEP limit so retained remote history matches the local snapshot.
export const MIRROR_MAX = 4 * 1024 * 1024;

export class Mirror {
  /// Join chunks only on demand instead of copying the entire transcript for each update.
  private parts: Uint8Array[] = [];
  private total = 0;
  private last = 0;
  /// Live lines cannot be positioned before the first snapshot, which will include them.
  private seeded = false;
  /// A snapshot becomes usable only after its final chunk arrives.
  private pending: Uint8Array[] | null = null;

  constructor(private max = MIRROR_MAX) {}

  get ready() {
    return this.seeded;
  }

  /// Collect snapshot chunks through seq; the final chunk replaces prior history. Return whether the snapshot is complete.
  seed(bytes: Uint8Array, seq: number, more = false): boolean {
    (this.pending ??= []).push(bytes.slice());
    if (more) return false;
    this.parts = this.pending;
    this.pending = null;
    this.total = this.parts.reduce((n, p) => n + p.length, 0);
    this.last = seq;
    this.seeded = true;
    this.trim();
    return true;
  }

  /// Return live bytes to render, or null when the snapshot already includes them or has not arrived.
  absorb(seq: number, bytes: Uint8Array): Uint8Array | null {
    if (!this.seeded || seq <= this.last) return null;
    this.last = seq;
    const copy = bytes.slice();
    this.parts.push(copy);
    this.total += copy.length;
    this.trim();
    return copy;
  }

  /// Return retained conversation bytes when reattaching the view.
  bytes(): Uint8Array {
    if (this.parts.length > 1) {
      this.parts = [concat(this.parts)];
      this.total = this.parts[0].length;
    }
    return this.parts[0] ?? new Uint8Array(0);
  }

  private trim() {
    if (this.total <= this.max) return;
    const all = concat(this.parts);
    const cut = all.subarray(all.length - this.max);
    this.parts = [cut];
    this.total = cut.length;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
