/// Back falso para o navegador puro (`npm run dev` e abrir localhost:1420):
/// a UI inteira roda com dados de amostra, sem subir o Tauri. Só entra quando
/// `window.__TAURI_INTERNALS__` não existe — dentro do app não é carregado.
import * as team from "./team";
import type { Board, Issue, LinearStatus, Scripts, Workspace } from "./types";

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
  model: "",
  effort: "",
  port: 3100,
  issue: null,
  pr: null,
  cleaned: false,
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
      { id: "t1", title: "conversa 1", status: "pronta", note: null, tokens: 57_000 },
      { id: "t2", title: "conversa 2", status: "pronta", note: null, tokens: 112_400 },
    ]),
    ws("ui-2231", "p2", "prometheus", "Tela igual ao Conductor", "Fazendo", [
      { id: "t3", title: "conversa 1", status: "rodando", note: "Edit src/style.css", tokens: 23_800 },
    ]),
    // Uma pergunta esperando você é justamente o que vira novidade.
    Object.assign(
      ws("icone-2140", "p2", "prometheus", "Ícone do app", "Code review", [
        { id: "t4", title: "conversa 1", status: "querendo", note: "Qual tamanho de ícone você quer gerar?", tokens: 8_100 },
      ]),
      { unread: true, pr: { number: 42, title: "feat(quadro): ícone do app", isDraft: false, state: "OPEN" } },
    ),
    // PR mergeado: é este que mostra o selo no card e o "Concluir" na barra.
    Object.assign(
      ws("dock-1130", "p2", "prometheus", "Porta do dock por worktree", "Code review", [
        { id: "t5", title: "conversa 1", status: "pronta", note: null, tokens: 44_200 },
      ]),
      { pr: { number: 40, title: "feat(dock): porta por worktree", isDraft: false, state: "MERGED" } },
    ),
    // Arquivado que ainda ocupa disco: é ele que a folha de limpeza lista.
    Object.assign(
      ws("linear-0912", "p1", "njord", "Conectar o Linear", "Feito", [
        { id: "t7", title: "conversa 1", status: "desligada", note: null, tokens: 66_000 },
      ]),
      { archived: true, pr: { number: 8, title: "feat: conectar o Linear", isDraft: false, state: "MERGED" } },
    ),
    Object.assign(
      ws("porta-1751", "p1", "njord", "Porta ocupada no setup", "Travado", [
        { id: "t8", title: "conversa 1", status: "desligada", note: null, tokens: 12_000 },
      ]),
      { archived: true },
    ),
    // Worktree devolvido: o card que sobrou de um trabalho que acabou.
    Object.assign(
      ws("idioma-1348", "p2", "prometheus", "O app fala inglês", "Feito", [
        { id: "t6", title: "conversa 1", status: "desligada", note: null, tokens: 91_000 },
      ]),
      {
        archived: true,
        cleaned: true,
        pr: { number: 17, title: "feat(idioma): o app fala inglês", isDraft: false, state: "MERGED" },
      },
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

/// Os scripts de cada workspace. Um repo com tudo declarado e dois runs, para a
/// lista do botão ter o que mostrar; e um sem nada, que é o estado que o convite
/// de "Adicionar script" existe para cobrir.
const scripts: Record<string, Scripts> = {
  "sessao-0929": {
    file: ".conductor/settings.toml",
    inherited: false,
    setup: "bin/setup",
    runs: [
      { name: "web", command: "bin/dev --port $PROMETHEUS_PORT" },
      { name: "worker", command: "bin/jobs" },
    ],
    archive: null,
    copy: [".env", "config/master.key"],
    port: 3100,
  },
  "ui-2231": {
    file: ".prometheus/settings.toml",
    inherited: true,
    setup: "npm install",
    runs: [{ name: "run", command: "npm run dev -- --port $PROMETHEUS_PORT" }],
    archive: null,
    copy: [".env"],
    port: 3110,
  },
};
const noScripts: Scripts = { file: null, inherited: false, setup: null, runs: [], archive: null, copy: [], port: 3120 };

/// Os docks que existem, pela mesma chave do Rust: `<workspace>:<tipo>`, e se
/// o processo está vivo. O setup "termina" sozinho pouco depois de subir, para
/// a tela do que já rodou existir no navegador.
const docks = new Map<string, boolean>();
const DONE = "\r\n\x1b[32m✓ terminou\x1b[0m\r\n";

const SCRIPT_OUT =
  "\x1b[2m$ npm run dev -- --port 3110\x1b[0m\r\n\r\n" +
  "  \x1b[32m➜\x1b[0m  Local:   \x1b[36mhttp://localhost:3110/\x1b[0m\r\n" +
  "  \x1b[32m➜\x1b[0m  ready in 231 ms\r\n\r\n";

let linear: LinearStatus = { connected: false, who: null, busy: false };

const issue = (
  identifier: string,
  title: string,
  priority: number,
  state: [string, string, string],
  project: string | null,
  hours: number,
  description: string | null = null,
): Issue => ({
  id: `id-${identifier}`,
  identifier,
  title,
  description,
  url: `https://linear.app/moabi/issue/${identifier}/${title.toLowerCase().replace(/\W+/g, "-")}`,
  branch_name: `gustavo/${identifier.toLowerCase()}-${title.toLowerCase().replace(/\W+/g, "-").slice(0, 40)}`,
  priority,
  priority_label: ["Sem prioridade", "Urgente", "Alta", "Média", "Baixa"][priority],
  state: { name: state[0], kind: state[1], color: state[2] },
  team: identifier.split("-")[0],
  project,
  labels: [],
  updated_at: new Date(Date.now() - hours * 3_600_000).toISOString(),
});
const DOING: [string, string, string] = ["In Progress", "started", "#f2c94c"];
const TODO: [string, string, string] = ["Todo", "unstarted", "#e2e2e2"];
const BACKLOG: [string, string, string] = ["Backlog", "backlog", "#bec2c8"];
const ISSUES: Issue[] = [
  issue("MOA-142", "Conectar o Linear ao Prometheus", 2, DOING, "Integrações", 1, "Aba de issues e criar workspace a partir de uma delas."),
  issue("MOA-137", "[Quadro] Card arrastado entre colunas perde a etapa quando o mouse solta fora da coluna (drop + reordenar)", 1, DOING, "Quadro", 5),
  issue("MOA-151", "Mostrar tokens de contexto no card", 3, TODO, "Quadro", 26),
  issue("MOA-149", "Atalho ⌘, para configurações", 4, TODO, null, 30),
  issue("MOA-120", "Explorar sync com Notion", 0, BACKLOG, "Integrações", 240),
];

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
    // O time fica no localStorage aqui, para sobreviver a recarregar a aba —
    // no app é o `team.json` do back.
    case "team_config":
      return { config: JSON.parse(localStorage.getItem("mock:team") ?? "null"), default_name: "Você" };
    case "team_config_set":
      if (args.config) localStorage.setItem("mock:team", JSON.stringify(args.config));
      else localStorage.removeItem("mock:team");
      return;
    case "pty_buffer": {
      // Chave com `:` é dock; sem, é conversa de agente.
      const s = String(args.session);
      const text = !s.includes(":") ? SAMPLE : docks.get(s) === false ? SCRIPT_OUT + DONE : SCRIPT_OUT;
      return [...new TextEncoder().encode(text)];
    }
    case "workspace_diff":
      return changes;
    case "list_dir":
      return tree[args.rel ?? ""] ?? [];
    case "read_file":
      if (args.rel in files) return files[args.rel];
      // Como o back de verdade: código, e não frase. O front traduz.
      throw args.rel.endsWith(".lock")
        ? `i18n:${JSON.stringify({ code: "err.session.tooBig", args: { kb: 2140 } })}`
        : `i18n:${JSON.stringify({ code: "err.session.binary" })}`;
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
    // Como no Rust: worktree devolvido não tem branch para ler.
    case "workspace_branch": {
      const target = board.workspaces.find((x) => x.id === args.id);
      return target && !target.cleaned ? target.branch : null;
    }
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
    // O lançador inteiro funciona no navegador, e o workspace novo nasce sem
    // script nenhum — que é o estado em que a aba Setup tem algo a dizer.
    case "create_workspace": {
      const draft = args.draft;
      const id = `nova-${nextId++}`;
      const repo = String(draft.project).split("/").pop() ?? "repo";
      const fresh = ws(id, draft.project, repo, draft.title || draft.branch, draft.stage, [
        { id: `t-${id}`, title: "conversa", status: "pronta", note: null, tokens: null },
      ]);
      fresh.branch = draft.branch || "main";
      fresh.model = draft.model;
      fresh.effort = draft.effort;
      fresh.issue = draft.issue ?? null;
      board.workspaces.push(fresh);
      emit("board", board);
      return fresh;
    }
    case "workspace_scripts":
      return scripts[args.id] ?? noScripts;
    case "dock_state":
      return [...docks]
        .filter(([k]) => k.startsWith(`${args.id}:`))
        .map(([k, alive]) => ({ kind: k.split(":")[1], alive }));
    case "create_scripts_file":
      return ".prometheus/settings.toml";
    case "scripts_prompt":
      return "Descubra como preparar e como rodar este projeto, e escreva isso em `.prometheus/settings.toml`.";
    case "open_run":
      console.log("abrir no navegador: http://localhost:" + ((scripts[args.id] ?? noScripts).port ?? 0));
      return null;
    // Só o workspace que já está em code review tem PR — é assim que se vê o
    // botão aparecendo num e não no outro.
    case "pr_open":
      return board.workspaces.find((x) => x.id === args.id)?.pr ?? null;
    // No navegador não há `gh`: o que o quadro já sabe é o que ele continua
    // sabendo.
    case "refresh_prs":
      return null;
    case "finish_workspace": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target) {
        target.stage = board.stages[board.stages.length - 1];
        target.archived = true;
        target.tabs.forEach((t) => (t.status = "desligada"));
      }
      emit("board", board);
      return;
    }
    case "cleanup_list":
      return board.workspaces
        .filter((x) => x.archived && !x.cleaned)
        .map((x, i) => ({
          id: x.id,
          title: x.title,
          repoName: x.repo_name,
          branch: x.branch,
          worktree: x.worktree,
          sizeKb: 2_900_000 - i * 700_000,
          pr: x.pr?.number ?? null,
          // Um bloqueado na lista é o que mostra a linha apagada com o motivo.
          blocked: i === 1 ? 'i18n:{"args":{"n":"3"},"code":"err.cleanup.dirty"}' : null,
        }));
    case "cleanup_worktree": {
      const target = board.workspaces.find((x) => x.id === args.id);
      if (target) target.cleaned = true;
      emit("board", board);
      return;
    }
    case "open_pr":
      console.log("abrir o PR de " + args.id + " no navegador");
      return null;
    case "pr_prompt":
      return [
        "Quero abrir um PR deste worktree.",
        "",
        "Há 2 arquivos com mudanças fora de commit. A branch atual é `mock/ajuste`; o alvo é `origin/main`. Ainda não há branch upstream.",
      ].join("\n");
    case "open_dock": {
      const key = `${args.id}:${args.kind}`;
      docks.set(key, true);
      if (args.kind === "setup") {
        setTimeout(() => {
          if (!docks.get(key)) return;
          docks.set(key, false);
          emit("pty", [key, [...new TextEncoder().encode(DONE)]]);
          emit("pty-closed", [key, 0]);
        }, 1500);
      }
      return key;
    }
    case "close_dock":
      docks.delete(`${args.id}:${args.kind}`);
      return;
    case "new_tab":
      return { id: "t1" };
    case "resume_tab":
      return true;
    // Pasta (projeto novo) não tem o que devolver no navegador. Arquivos, sim:
    // dois de mentira, para o clipe do lançador ter o que mostrar.
    case "plugin:dialog|open":
      return args.options?.multiple
        ? ["/Users/gustavo/dev/njord/docs/spec.md", "/Users/gustavo/Desktop/tela.png"]
        : null;
    // O Linear de mentira: conectar demora um pouco, como o navegador demora,
    // e avisa pelo mesmo evento que o back avisa.
    case "linear_status":
      return linear;
    // O back de verdade guarda o idioma para as poucas frases que escreve
    // inteiras; aqui não há nenhuma, mas o comando existe dos dois lados.
    case "set_lang":
      return undefined;

    case "linear_connect":
      linear = { ...linear, busy: true };
      emit("linear", linear);
      return new Promise((done) =>
        setTimeout(() => {
          linear = {
            connected: true,
            busy: false,
            who: { name: "Gustavo Brancaglione", email: "gustavo@exemplo.com", org: "Moabi", org_key: "moabi" },
          };
          emit("linear", linear);
          done(linear);
        }, 1200),
      );
    case "linear_issues":
      if (!linear.connected) {
        return Promise.reject(`i18n:${JSON.stringify({ code: "err.linear.off" })}`);
      }
      return new Promise((done) => setTimeout(() => done({ issues: ISSUES, fetched_at: Date.now() / 1000 }), 600));
    case "linear_open":
      console.log("abrir no Linear:", args.url);
      return null;
    case "linear_disconnect":
      linear = { connected: false, who: null, busy: false };
      emit("linear", linear);
      return linear;
    // Fora do Tauri não existe bundle para perguntar a versão. Dizer isso na
    // tela é melhor que repetir aqui um número que envelhece sozinho.
    case "plugin:app|version":
      return "0.0.0-mock";
    // O updater também não tem o que fazer aqui: `null` é "nada novo", que é
    // a resposta honesta para uma aba de navegador.
    case "plugin:updater|check":
      return null;
    default:
      return null;
  }
}

/* ---------- o relay de mentira ---------- */

/// Um time com dois colegas fixos, para mexer na tela sem relay: o `welcome`
/// chega meio segundo depois de conectar, `me` troca o nome, e o resto é
/// silêncio. `mock.presence(false)` derruba um colega para ver a lista mudar.
let marcusOnline = true;
const fakes: team.SocketLike[] = [];
function fakeSocket(url: string): team.SocketLike {
  const u = new URL(url);
  const me = u.searchParams.get("m") ?? "eu";
  let name = u.searchParams.get("n") ?? "Você";
  const members = () => [
    { id: me, name, online: true },
    { id: "marcus", name: "Marcus Hale", online: marcusOnline },
    { id: "john", name: "John Okafor", online: false },
  ];
  const s: team.SocketLike & { presence: () => void } = {
    binaryType: "blob",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    presence: () => s.onmessage?.({ data: JSON.stringify({ t: "presence", members: members() }) }),
    send(data) {
      if (typeof data !== "string" || data === "ping") return;
      const frame = JSON.parse(data);
      if (frame.t === "me") {
        name = frame.name;
        s.presence();
      }
    },
    close() {
      fakes.splice(fakes.indexOf(s), 1);
      setTimeout(() => s.onclose?.());
    },
  };
  fakes.push(s);
  setTimeout(() => {
    s.onopen?.();
    s.onmessage?.({
      data: JSON.stringify({ t: "welcome", you: me, members: members(), shares: [], inbox: [], watching: {} }),
    });
  }, 500);
  return s;
}
team.useTransport({
  needsRelay: false,
  socket: fakeSocket,
  create: async () => ({ team: "timeDeMentira", secret: "segredoDeMentira" }),
});

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

// Atalhos para testar os cards de resposta pelo console: `mock.ask()`,
// `mock.perm()` e `mock.plan()`.
w.mock = {
  presence: (online: boolean) => {
    marcusOnline = online;
    for (const s of fakes) (s as unknown as { presence: () => void }).presence();
  },
  plan: () =>
    emit("plan", {
      session: "t1",
      plan: [
        "# Plano: trocar o ponto verde por uma onda",
        "",
        "## Contexto",
        "O dock mostra um ponto verde quando há processo de pé. Cor parada não separa \"rodando\" de \"parou faz um segundo\".",
        "",
        "## Passos",
        "1. Desenhar `audio-lines` em `icons.ts` e animar as seis barras no CSS.",
        "2. Trocar o ponto pela onda em `dockbar.ts`, herdando a cor da aba.",
        "3. Conferir no navegador com `mock.drop` e no app com `npm run app`.",
      ].join("\n"),
    }),
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
