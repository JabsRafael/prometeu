/// Generate a new workspace branch name.

/// Use readable word pairs instead of timestamp names that collide when created together or in another year. Lowercase ASCII masculine nouns match their adjectives and remain safe in branch names.
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

/// Choose among 16,384 pairs; freshBranch checks uniqueness.
export function pair(rand: () => number = Math.random) {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  return `${pick(NOUNS)}-${pick(ADJS)}`;
}

/// Two words plus four digits provide 163,840,000 combinations. Retry collisions, then increment the suffix to guarantee termination. Treat both local and remote branch names as taken.
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
