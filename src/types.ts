export type Status = "rodando" | "querendo" | "pronta" | "desligada";

/// Como cada estado se chama na tela. Um lugar só: estava escrito igual no
/// quadro e no cabeçalho, e duas cópias de um rótulo é uma cópia que um dia
/// deixa de bater com a outra.
export const LABEL: Record<Status, string> = {
  rodando: "rodando",
  querendo: "quer você",
  pronta: "pronta",
  desligada: "desligada",
};

export type Tab = {
  id: string;
  title: string;
  status: Status;
  note: string | null;
};

export type Project = { id: string; name: string; path: string };

export type Workspace = {
  id: string;
  title: string;
  project: string;
  repo: string;
  repo_name: string;
  branch: string;
  worktree: string;
  /// A etapa em que você pôs o trabalho. `Status` é o que o agente está
  /// fazendo; esta é a sua leitura do trabalho, e as duas não se misturam.
  stage: string;
  archived: boolean;
  pinned: boolean;
  unread: boolean;
  /// `--model` e `--effort` das conversas daqui, escolhidos no lançador e
  /// válidos para as abas que vierem (⌘T, retomar). Vazio é o padrão do
  /// Claude Code.
  model: string;
  effort: string;
  /// Base das dez portas reservadas a este worktree.
  port: number | null;
  tabs: Tab[];
  active: string | null;
};

/// Os terminais do dock. Não são sessão de agente: sem hook, sem card, sem
/// quadro. `setup` e `run` saem do settings.toml do repositório e são abas
/// fixas; os shells são `terminal`, `terminal-2`, `terminal-3`… — um por aba
/// que o + abriu, e nenhum existe antes de você pedir.
export type DockKind = "setup" | "run" | `terminal${string}`;

/// Aba de shell, e não script do repositório. É o que decide se o ✕ encerra um
/// processo (setup) ou fecha a aba inteira (terminal).
export const isTerm = (kind: DockKind) => kind.startsWith("terminal");

/// `terminal` é o número 1; do segundo em diante o sufixo é o número. É o que
/// ordena a barra e o que vira o rótulo — sem uma tabela para manter.
export const termNumber = (kind: DockKind) => Number(kind.slice("terminal-".length)) || 1;
export const termKind = (n: number): DockKind => (n === 1 ? "terminal" : `terminal-${n}`);

/// Um dock que existe: está de pé, ou morreu e deixou a rolagem — com o
/// `✗ saiu com código` no fim, que é o que a aba mostra.
export type DockState = { kind: DockKind; alive: boolean };

/// O que o repositório declara em `.prometheus/settings.toml` (ou no
/// `.conductor/settings.toml` que ele já tinha), mais a porta deste worktree.
export type Scripts = {
  /// Qual arquivo respondeu. `null` é "este repo não declara nada" — e é o que
  /// faz a aba desenhar o convite em vez de um terminal mudo.
  file: string | null;
  setup: string | null;
  runs: { name: string; command: string }[];
  archive: string | null;
  port: number | null;
};

export type Board = { stages: string[]; projects: Project[]; workspaces: Workspace[] };

/// Um arquivo mexido no worktree. `patch` são os trechos `@@` do diff — vazio
/// quando não há o que desenhar (binário, ou grande demais).
export type Change = {
  path: string;
  added: number;
  removed: number;
  new_file: boolean;
  patch: string;
};

export type Option = { label: string; description?: string };
export type Question = {
  question: string;
  header?: string;
  options?: Option[];
  multiSelect?: boolean;
};

const RANK: Record<Status, number> = { querendo: 3, rodando: 2, pronta: 1, desligada: 0 };

/// O estado do workspace é o da aba mais urgente: uma aba travada numa pergunta
/// manda no card inteiro. Mesma regra do `rank` no Rust.
export function worst(ws: Workspace): Tab | undefined {
  return [...ws.tabs].sort((a, b) => RANK[b.status] - RANK[a.status])[0];
}

export function statusOf(ws: Workspace): Status {
  return worst(ws)?.status ?? "desligada";
}
