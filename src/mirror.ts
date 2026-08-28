/// A conversa de uma aba que roda em outro Mac.
///
/// Duas coisas chegam pelo relay, e podem cruzar no caminho: a **conversa
/// inteira** ("estes bytes, até a linha N", em partes) e as **linhas ao vivo**,
/// cada uma com o número que o back deu. Quem recebe precisa juntar as duas
/// sem repetir nem perder nada — e é só isso que este módulo faz, para poder
/// ser testado sem rede e sem tela.
///
/// A regra é uma: linha com número até o da conversa já está dentro dela.
/// Nada de comparar bytes, nada de adivinhar.

/// Quanto se guarda de cada conversa. O mesmo teto do back (`KEEP`, em
/// `chat.rs`): é a conversa que ele teria mandado.
export const MIRROR_MAX = 4 * 1024 * 1024;

export class Mirror {
  /// Guardado em pedaços e só juntado quando alguém pede: concatenar a cada
  /// chunk é copiar meio megabyte por tecla.
  private parts: Uint8Array[] = [];
  private total = 0;
  private last = 0;
  /// A conversa ainda não chegou. Até chegar, linha ao vivo não tem como ser
  /// posicionada — e vai estar dentro dela de qualquer jeito.
  private seeded = false;
  /// As partes da conversa que está chegando: só vale quando a última fechar.
  private pending: Uint8Array[] | null = null;

  constructor(private max = MIRROR_MAX) {}

  get ready() {
    return this.seeded;
  }

  /// Uma parte da conversa inteira, até a linha `seq`. `more` é "vem outra
  /// atrás"; a última substitui o que havia: é a verdade mais nova, e o que
  /// veio antes dela já está contado. Devolve se a conversa fechou.
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
