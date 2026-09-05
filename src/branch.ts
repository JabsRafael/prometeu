/// O nome da branch de um workspace novo.

/// Palavras, não relógio. `prometeu/0901-1601` só dizia o minuto em que o
/// workspace nasceu: abrir três de uma vez dava três nomes iguais (o segundo
/// virava `-2`, o terceiro `-3`, e nenhum dizia nada), e o mesmo dia-mês volta
/// igualzinho no ano que vem. Um par de palavras se distingue de longe e ainda
/// se fala em voz alta — "aquele do farol-quieto".
///
/// Tudo ASCII e minúsculo, que é o que cabe num nome de branch sem susto: só
/// substantivo masculino (o adjetivo concorda) e sem acento por construção.
const NOUNS = [
  "farol", "tear", "cais", "porto", "ferro", "cobre", "bronze", "cedro",
  "junco", "barro", "vinco", "orvalho", "cometa", "quartzo", "granito", "sino",
  "remo", "leme", "mastro", "cravo", "pinho", "campo", "morro", "riacho",
  "vale", "prego", "forno", "lago", "muro", "cume", "trilho", "arco",
  "vento", "fogo", "mar", "rio", "sol", "chao", "ceu", "gelo",
  "raio", "trovao", "relampo", "nevoeiro", "horizonte", "oceano", "bosque", "brejo",
  "mangue", "deserto", "planalto", "penhasco", "rochedo", "seixo", "cascalho", "cristal",
  "diamante", "rubi", "topazio", "basalto", "marmore", "carvao", "aco", "ouro",
  "estanho", "zinco", "niquel", "aluminio", "bambu", "cacto", "carvalho", "olmo",
  "freixo", "bordo", "cipreste", "eucalipto", "pinheiro", "coqueiro", "salgueiro", "limoeiro",
  "cajueiro", "umbuzeiro", "ipe", "jasmim", "trevo", "musgo", "broto", "ramo",
  "tronco", "galho", "fruto", "grao", "ninho", "casulo", "falcao", "gaviao",
  "corvo", "pardal", "tucano", "canario", "sabia", "condor", "albatroz", "pelicano",
  "lobo", "urso", "tigre", "leao", "lince", "cervo", "alce", "castor",
  "esquilo", "coelho", "tatu", "tamandua", "golfinho", "boto", "cavalo", "potro",
  "barco", "veleiro", "navio", "bote", "conves", "timao", "astro", "planeta",
];

const ADJS = [
  "lento", "quieto", "claro", "escuro", "largo", "estreito", "firme", "novo",
  "fundo", "alto", "macio", "aceso", "bravo", "sereno", "frio", "morno",
  "seco", "limpo", "denso", "leve", "forte", "torto", "reto", "raso",
  "manso", "duro", "vivo", "curto", "longo", "cheio", "solto", "aberto",
  "calmo", "veloz", "agil", "rapido", "suave", "brando", "tenro", "rigido",
  "solido", "robusto", "estavel", "seguro", "certo", "justo", "franco", "sincero",
  "leal", "fiel", "nobre", "digno", "gentil", "amigo", "alegre", "feliz",
  "contente", "risonho", "radiante", "vistoso", "belo", "bonito", "lindo", "elegante",
  "simples", "singelo", "modesto", "discreto", "sutil", "fino", "delicado", "miudo",
  "pequeno", "grande", "imenso", "vasto", "amplo", "gigante", "colossal", "profundo",
  "elevado", "baixo", "plano", "liso", "rugoso", "aspero", "redondo", "curvo",
  "oval", "oco", "compacto", "espesso", "ralo", "farto", "rico", "raro",
  "unico", "diverso", "plural", "inteiro", "completo", "pleno", "maduro", "jovem",
  "antigo", "eterno", "duravel", "perene", "constante", "tenaz", "valente", "ousado",
  "audaz", "esperto", "atento", "curioso", "sagaz", "sabio", "astuto", "criativo",
  "dourado", "prateado", "azul", "verde", "rubro", "roxo", "branco", "negro",
];

/// Um par sorteado. 16.384 combinações: o `freshBranch` é que garante
/// que a sorteada não é de ninguém.
export function pair(rand: () => number = Math.random) {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  return `${pick(NOUNS)}-${pick(ADJS)}`;
}

/// Duas palavras e quatro dígitos aleatórios: 163.840.000 combinações.
/// A primeira branch deste padrão que ainda não é de ninguém. Sortear de novo
/// resolve quase toda colisão; se o sorteio insistir num nome tomado, o número
/// no fim fecha a conta — sem ele, a busca poderia não terminar.
///
/// `taken` é o que o `list_branches` devolve, local e remota na mesma lista:
/// `origin/prometeu/…` conta como tomado.
export function freshBranch(taken: string[], rand: () => number = Math.random) {
  const has = (name: string) => taken.some((b) => b === name || b.endsWith(`/${name}`));
  let base = "";
  for (let tentativa = 0; tentativa < 20; tentativa++) {
    base = `prometeu/${pair(rand)}-${Math.floor(rand() * 10000).toString().padStart(4, "0")}`;
    if (!has(base)) return base;
  }
  for (let n = 2; ; n++) {
    const cand = `${base}-${n}`;
    if (!has(cand)) return cand;
  }
}
