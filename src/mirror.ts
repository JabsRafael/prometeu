/// A rolagem de uma conversa que roda em outro Mac.
///
/// Duas coisas chegam pelo relay, e podem cruzar no caminho: a **rolagem
/// inteira** ("estes bytes, até o pedaço N") e os **pedaços ao vivo**, cada um
/// com o número que o PTY deu. Quem recebe precisa juntar as duas sem repetir
/// nem perder nada — e é só isso que este módulo faz, para poder ser testado
/// sem terminal, sem rede e sem tela.
///
/// A regra é uma: pedaço com número até o da rolagem já está dentro dela.
/// Nada de comparar bytes, nada de adivinhar.

/// Quanto se guarda de cada conversa. O mesmo teto do back (`SCROLLBACK`, em
/// `pty.rs`): é a rolagem que ele teria mandado.
export const MIRROR_MAX = 512 * 1024;

export class Mirror {
  /// Guardado em pedaços e só juntado quando alguém pede: concatenar a cada
  /// chunk é copiar meio megabyte por tecla.
  private parts: Uint8Array[] = [];
  private total = 0;
  private last = 0;
  /// A rolagem ainda não chegou. Até chegar, pedaço ao vivo não tem como ser
  /// posicionado — e vai estar dentro dela de qualquer jeito.
  private seeded = false;

  constructor(private max = MIRROR_MAX) {}

  get ready() {
    return this.seeded;
  }

  /// A rolagem inteira, até o pedaço `seq`. Substitui o que havia: é a verdade
  /// mais nova, e o que veio antes dela já está contado.
  seed(bytes: Uint8Array, seq: number) {
    this.parts = [bytes.slice()];
    this.total = bytes.length;
    this.last = seq;
    this.seeded = true;
    this.trim();
  }

  /// Um pedaço ao vivo. Devolve o que a tela tem que escrever — `null` quando
  /// o pedaço já estava na rolagem, ou quando ela ainda não chegou.
  absorb(seq: number, bytes: Uint8Array): Uint8Array | null {
    if (!this.seeded || seq <= this.last) return null;
    this.last = seq;
    const copy = bytes.slice();
    this.parts.push(copy);
    this.total += copy.length;
    this.trim();
    return copy;
  }

  /// Tudo que se sabe da conversa, para redesenhar a tela ao voltar para ela.
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
