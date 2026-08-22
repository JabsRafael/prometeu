export type Status = "rodando" | "querendo" | "pronta" | "desligada";

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
  tabs: Tab[];
  active: string | null;
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
