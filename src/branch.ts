/// O nome da branch de um workspace novo.

/// Dia e horário. Só o horário (`prometheus/1508`) repetia todo dia: quem
/// trabalha sempre às 15h esbarrava, semanas depois, no `prometheus/1508` de
/// outro trabalho — a branch antiga voltava ao disco com os commits dela, e o
/// PR daquele nome (mergeado, branch remota já apagada) aparecia como se
/// fosse o desta sessão. Com o dia junto, o nome de hoje é só de hoje, e
/// continua dizendo quando o workspace nasceu.
export function stamp(now = new Date()) {
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/// A primeira branch deste padrão que ainda não é de ninguém. Dois workspaces
/// no mesmo minuto continuariam caindo no mesmo nome — e o segundo adotaria
/// calado o worktree do primeiro —, então quem chega depois ganha um número.
///
/// `taken` é o que o `list_branches` devolve, local e remota na mesma lista:
/// `origin/prometheus/…` conta como tomado. A busca termina porque a lista é
/// finita — algum número acima dela sobra.
export function freshBranch(taken: string[], now = new Date()) {
  const base = `prometheus/${stamp(now)}`;
  const has = (name: string) => taken.some((b) => b === name || b.endsWith(`/${name}`));
  if (!has(base)) return base;
  for (let n = 2; ; n++) {
    const cand = `${base}-${n}`;
    if (!has(cand)) return cand;
  }
}
