import { current as locale, t } from "./i18n";

export type Status = "rodando" | "querendo" | "pronta" | "desligada";

/// Como cada estado se chama na tela. Um lugar só: estava escrito igual no
/// quadro e no cabeçalho, e duas cópias de um rótulo é uma cópia que um dia
/// deixa de bater com a outra. O valor em si é do protocolo — é o que o back
/// manda e o que o CSS pinta —, e por isso não muda de idioma junto.
export const label = (status: Status) => t(`status.${status}`);

export type Tab = {
  id: string;
  title: string;
  status: Status;
  note: string | null;
  /// Tokens de contexto na última resposta: quão cheia está a janela. Vazio é
  /// conversa que ainda não respondeu.
  tokens: number | null;
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
  /// A issue do Linear de onde este trabalho saiu, se saiu de uma.
  issue: IssueRef | null;
  /// O PR desta branch como o `gh` respondeu da última vez. `MERGED` é o que
  /// faz a barra oferecer "Concluir" e o card ganhar o selo — é o sinal de que
  /// este trabalho acabou.
  pr: Pr | null;
  /// O worktree foi devolvido ao disco. O card fica como histórico: sem
  /// terminal, sem docks, sem arquivos — só o que ficou escrito.
  cleaned: boolean;
  tabs: Tab[];
  active: string | null;
};

/// O PR de uma branch, como o `gh` conta. `state` é `OPEN`, `MERGED` ou
/// `CLOSED`.
export type Pr = { number: number; title: string; isDraft: boolean; state: string };
export const merged = (ws: Workspace) => ws.pr?.state === "MERGED";

/// Arquivado que ainda tem um worktree só dele para devolver ao disco. O que
/// roda no próprio clone (worktree desligado no lançador) nunca teve: a pasta
/// é o repositório, e não há o que limpar.
export const hasWorktree = (ws: Workspace) => ws.archived && !ws.cleaned && ws.worktree !== ws.repo;

/// Um worktree que pode voltar para o disco, e o que ele ocupa. `blocked` é o
/// erro do back dizendo por que não pode — passa por `fromBack` como qualquer
/// outro.
export type Cleanable = {
  id: string;
  title: string;
  repoName: string;
  branch: string;
  worktree: string;
  sizeKb: number;
  pr: number | null;
  blocked: string | null;
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
  /// O arquivo é o do clone de origem, porque este worktree não tem o seu. É
  /// comum `.prometheus/` estar no `.gitignore`: sem herdar, todo worktree
  /// nascia sem Run. "Abrir o settings.toml" nesse caso copia o herdado para cá.
  inherited: boolean;
  setup: string | null;
  runs: { name: string; command: string }[];
  archive: string | null;
  /// O que este worktree recebe do clone de origem antes do setup: `.env` e o
  /// resto que o `.gitignore` esconde e nenhum comando reconstrói. É a lista do
  /// clone, não o que falta aqui — por isso não encolhe depois da cópia, e a
  /// aba Setup continua existindo num repositório que não declara `setup`.
  copy: string[];
  port: number | null;
};

export type Board = { stages: string[]; projects: Project[]; workspaces: Workspace[] };

/// Quem está do outro lado da conexão com o Linear: a pessoa e o workspace
/// (a organização) que ela autorizou.
export type LinearWho = { name: string; email: string; org: string; org_key: string };
/// O que da issue o workspace guarda: chip no card, link, e "esta já tem
/// workspace" na aba.
export type IssueRef = { id: string; identifier: string; title: string; url: string };

/// Uma issue do Linear como a aba mostra. `state.kind` é o tipo do Linear
/// (`started`, `unstarted`, `backlog`, `triage`) e é o que agrupa; `priority`
/// vai de 0 (sem) a 4 (baixa), com 1 sendo urgente — a escala deles.
export type Issue = IssueRef & {
  description: string | null;
  branch_name: string;
  priority: number;
  priority_label: string;
  state: { name: string; kind: string; color: string };
  team: string;
  project: string | null;
  labels: { name: string; color: string }[];
  updated_at: string;
};
export type Issues = { issues: Issue[]; fetched_at: number };

/// `busy` é um fluxo esperando o navegador — a tela mostra isso mesmo que
/// você saia e volte no meio.
export type LinearStatus = { connected: boolean; who: LinearWho | null; busy: boolean };

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

/// A conversa mais pesada do workspace — é a que está mais perto de compactar.
export function heaviest(ws: Workspace): Tab | undefined {
  return ws.tabs.filter((t) => t.tokens).sort((a, b) => b.tokens! - a.tokens!)[0];
}

/// `57k`, `1,2M`: o tamanho que cabe numa pastilha. Abaixo de mil é o número.
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })}M`;
}
