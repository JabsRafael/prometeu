/// Back falso para o navegador puro (`npm run dev` e abrir localhost:1420):
/// a UI inteira roda com dados de amostra, sem subir o Tauri. Só entra quando
/// `window.__TAURI_INTERNALS__` não existe — dentro do app não é carregado.
import type { Board, Workspace } from "./types";

type Handler = (e: { event: string; id: number; payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
let nextId = 1;
const w = window as unknown as Record<string, unknown>;

const ws = (
  id: string,
  project: string,
  repo: string,
  title: string,
  stage: string,
  tabs: Workspace["tabs"],
): Workspace => ({
  id,
  title,
  project,
  repo: `/Users/gustavo/dev/${repo}`,
  repo_name: repo,
  branch: `prometheus/${id}`,
  worktree: `~/.prometheus/worktrees/${repo}/prometheus-${id}`,
  stage,
  archived: false,
  pinned: false,
  unread: false,
  tabs,
  active: tabs[0]?.id ?? null,
});

const board: Board = {
  stages: ["Preparando", "Fazendo", "Code review", "Travado", "Feito"],
  projects: [
    { id: "p1", name: "njord", path: "/Users/gustavo/dev/njord" },
    { id: "p2", name: "prometheus", path: "/Users/gustavo/dev/prometheus" },
  ],
  workspaces: [
    ws("sessao-0929", "p1", "njord", "Ola", "Fazendo", [
      { id: "t1", title: "conversa 1", status: "pronta", note: null },
      { id: "t2", title: "conversa 2", status: "pronta", note: null },
    ]),
    ws("ui-2231", "p2", "prometheus", "Tela igual ao Conductor", "Fazendo", [
      { id: "t3", title: "conversa 1", status: "rodando", note: "Edit src/style.css" },
    ]),
    // Uma pergunta esperando você é justamente o que vira novidade.
    Object.assign(
      ws("icone-2140", "p2", "prometheus", "Ícone do app", "Code review", [
        { id: "t4", title: "conversa 1", status: "querendo", note: "Qual tamanho de ícone você quer gerar?" },
      ]),
      { unread: true },
    ),
  ],
};

const tree: Record<string, { name: string; path: string; dir: boolean }[]> = {
  "": [
    ...[".github", "app", "bin", "config", "db", "docs", "lib", "log", "public", "script", "spec", "storage", "tmp", "vendor"].map(
      (name) => ({ name, path: name, dir: true }),
    ),
    ...[".dockerignore", ".env.example", ".gitignore", ".rspec", ".rubocop.yml", ".ruby-version", "CLAUDE.md", "Dockerfile", "Gemfile", "Gemfile.lock", "README.md", "config.ru"].map(
      (name) => ({ name, path: name, dir: false }),
    ),
  ],
  app: ["adapters", "assets", "channels", "controllers", "helpers", "javascript", "jobs", "models", "views"].map((name) => ({
    name,
    path: `app/${name}`,
    dir: true,
  })),
  "app/adapters": ["transcriber.rb", "waha.rb"].map((name) => ({ name, path: `app/adapters/${name}`, dir: false })),
  bin: ["brakeman", "ci", "dev", "rails", "rake", "rubocop", "setup"].map((name) => ({ name, path: `bin/${name}`, dir: false })),
};

const files: Record<string, string> = {
  "app/adapters/transcriber.rb": `class Transcriber
  MODEL = "gemini-3.6-flash".freeze

  class << self
    def call(audio, extension:)
      Tempfile.create([ "audio", extension ]) do |file|
        file.binmode
        file.write(audio)
        file.flush

        transcription(file.path)
      end
    end

    private
      def transcription(path)
        RubyLLM.transcribe(
          path, model: MODEL, provider: :gemini, assume_model_exists: true, language: "portuguese"
        ).text
      end
  end
end
`,
  "CLAUDE.md": "# Njord\n\nControle financeiro pessoal em Rails.\n\n## Regras\n\n- Competência é o dia em que o dinheiro **saiu**.\n- Rodar `bin/ci` antes de abrir PR. Ver [docs](docs/README.md).\n",
  ".gitignore": "# Ignore bundler config.\n/.bundle\n/log/*\n!/log/.keep\n/tmp/*\n",
  Dockerfile: "# syntax=docker/dockerfile:1\nFROM ruby:3.4-slim AS base\nWORKDIR /rails\nENV RAILS_ENV=production\nRUN apt-get update -qq && apt-get install -y curl\nCMD [\"bin/rails\", \"server\"]\n",
  ".rubocop.yml": "# Omakase Ruby styling for Rails\ninherit_gem: { rubocop-rails-omakase: rubocop.yml }\n\nAllCops:\n  TargetRubyVersion: 3.4\n  NewCops: enable\n",
};

const changes = [
  {
    path: "src/style.css",
    added: 6,
    removed: 2,
    new_file: false,
    patch: [
      "@@ -212,7 +212,11 @@ .card {",
      "   display: flex;",
      "-  gap: 4px;",
      "-  padding: 8px;",
      "+  gap: 8px;",
      "+  padding: 12px;",
      "+  border-radius: var(--r-lg);",
      " }",
      "@@ -318,3 +322,6 @@ .foot {",
      " .foot .x:hover { color: var(--err); }",
      "+.foot .chip { padding: 0; }",
      "+.foot .chip .dot { width: 7px; }",
      "+",
    ].join("\n"),
  },
  {
    path: "src/icons.ts",
    added: 4,
    removed: 0,
    new_file: true,
    patch: [
      "@@ -0,0 +1,4 @@",
      '+export function icon(name: string, size = 16): string {',
      '+  const PATHS: Record<string, string> = { plus: "M5 12h14" };',
      "+  return `<svg width=\"${size}\">${PATHS[name]}</svg>`;",
      "+}",
    ].join("\n"),
  },
  { path: "public/logo.png", added: 0, removed: 0, new_file: true, patch: "" },
];

const SAMPLE =
  "\x1b[1mClaude Code\x1b[0m v2.1.238\r\n" +
  "Opus 5 (1M context) with high effort · Claude Max\r\n" +
  "~/.prometheus/worktrees/njord/prometheus-sessao-0929\r\n\r\n" +
  "\x1b[2m>\x1b[0m Me pergunte quais são as minhas 3 cores preferidas\r\n\r\n" +
  "● Verde anotado. Só uma das três — quer dizer as outras duas?\r\n\r\n" +
  "\x1b[2m✻ Cooked for 5s\x1b[0m\r\n\r\n" +
  "───────────────────────────────────────────────────────────────\r\n" +
  "\x1b[38;5;209m›\x1b[0m \x1b[7m \x1b[0m\r\n" +
  "───────────────────────────────────────────────────────────────\r\n";

function emit(event: string, payload: unknown) {
  handlers.get(event)?.forEach((h) => h({ event, id: nextId++, payload }));
}

function call(cmd: string, args: Record<string, any> = {}): unknown {
  switch (cmd) {
    case "plugin:event|listen": {
      const h = w[`_${args.handler}`] as Handler;
      handlers.set(args.event, [...(handlers.get(args.event) ?? []), h]);
      return nextId++;
    }
    case "load_board":
      return board;
    case "pty_buffer":
      return [...new TextEncoder().encode(SAMPLE)];
    case "workspace_diff":
      return changes;
    case "list_dir":
      return tree[args.rel ?? ""] ?? [];
    case "read_file":
      if (args.rel in files) return files[args.rel];
      throw args.rel.endsWith(".lock") ? "arquivo grande demais (2140 KB)" : "arquivo binário";
    case "rename_workspace": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target) target.title = args.title;
      emit("board", board);
      return;
    }
    case "rename_tab": {
      const target = board.workspaces.find((x) => x.id === args.workspace);
      const tab = target?.tabs.find((t) => t.id === args.tab);
      if (tab) tab.title = args.title;
      emit("board", board);
      return;
    }
    case "workspace_branch":
      return board.workspaces.find((x) => x.id === args.id)?.branch ?? null;
    case "set_stage": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target) target.stage = args.stage;
      emit("board", board);
      return;
    }
    case "pin_workspace": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target) target.pinned = args.pinned;
      emit("board", board);
      return;
    }
    case "set_unread": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target) target.unread = args.unread;
      emit("board", board);
      return;
    }
    case "look_at": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target?.unread) {
        target.unread = false;
        emit("board", board);
      }
      return;
    }
    case "archive_workspace": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target) target.archived = args.archived;
      // Como no Rust: arquivar derruba os processos das abas.
      if (target && args.archived) target.tabs.forEach((t) => (t.status = "desligada"));
      emit("board", board);
      return;
    }
    case "list_branches":
      return {
        all: [
          "origin/main", "main", "entire/checkpoints/v1", "manual-sleep-button",
          "dashboard-app-preview", "export-project-zip", "fix/deploy-build-cache",
          "password-reset-crud", "project-renaming", "refactor/railsway-specs-and-lint",
          "origin/entire/checkpoints/v1", "origin/manual-sleep-button",
        ],
        default: "origin/main",
      };
    case "open_dock":
      return `${args.id}:${args.kind}`;
    case "new_tab":
      return { id: "t1" };
    case "resume_tab":
      return true;
    case "plugin:dialog|open":
      return null;
    default:
      return null;
  }
}

w.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback(cb: Handler) {
    const id = nextId++;
    w[`_${id}`] = cb;
    return id;
  },
  unregisterCallback(id: number) {
    delete w[`_${id}`];
  },
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise.resolve(call(cmd, args)),
};

// Atalhos para testar os cards de resposta pelo console: `mock.ask()` e `mock.perm()`.
w.mock = {
  ask: () =>
    emit("question", {
      session: "t1",
      payload: {
        tool_input: {
          questions: [
            {
              question: "Qual é a sua cor preferida?",
              header: "Cor",
              options: [
                { label: "Azul", description: "Calmo e frio" },
                { label: "Verde", description: "Natureza" },
                { label: "Vermelho" },
              ],
            },
          ],
        },
      },
    }),
  /// Simula soltar arquivos num ponto da tela — o mesmo evento que o Tauri
  /// manda quando você arrasta de fora para dentro da janela.
  drop: (paths: string[], x = innerWidth / 2, y = innerHeight / 2) => {
    const position = { x: x * devicePixelRatio, y: y * devicePixelRatio };
    emit("tauri://drag-over", { position });
    emit("tauri://drag-drop", { paths, position });
  },
  over: (position: { x: number; y: number }) => emit("tauri://drag-over", { position }),
  perm: () =>
    emit("permission", {
      id: 1,
      session: "t1",
      payload: { tool_name: "Bash", tool_input: { command: "npm run build" } },
    }),
};
