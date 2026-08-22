# Prometheus

Quadro Kanban global por cima de sessões do Claude Code, cada uma no seu worktree.

Junta o que é bom no Conductor (worktree isolado por sessão, script de setup por
repo) com o que é bom no Vibe Island (você fica sabendo na hora que o agente
precisa de você), e adiciona a etapa que **você** arrasta.

Sessão é one-off: nasce, faz, morre. Sem passar artefato de uma sessão para outra.

## Como funciona

Três camadas. Só a de cima é escrita com carinho.

```
overlay (TS)   card da pergunta, quadro, notificação        <- seu
   ^  clique                                    v evento
hooks (socket) prometheus-hook <-> prometheus.sock          <- cola
   ^  decisão                                   v payload
PTY            o `claude` de verdade, TUI inteira           <- de graça
```

O app **não reimplementa nada** do Claude Code. Roda o CLI de verdade num
pseudo-terminal e intercepta só os momentos que merecem UI nativa. Todo comando,
autocomplete, plan mode, skill e release novo continuam funcionando porque é o
Claude Code de verdade rodando ali.

### O ida-e-volta

1. O Claude Code precisa de permissão e dispara o hook `PermissionRequest`.
2. `prometheus-hook` lê o payload no stdin e o entrega pelo socket unix.
3. O app desenha o card e **o hook fica bloqueado** (`timeout: 86400` no settings).
4. Você clica. A decisão volta pelo socket, sai no stdout do hook, e o Claude Code
   a obedece — a TUI mostra `Allowed by PermissionRequest hook`.

Uma conexão por invocação de hook, então a conexão já é a correlação: sem ids de
mensagem, sem multiplexação.

### O caso do AskUserQuestion

Verificado empiricamente no Claude Code 2.1.237, e é a única sutileza real do
projeto:

- O hook **não consegue** escolher a resposta. Devolver `updatedInput` com
  `answers` preenchido não funciona: `permissionDecision: "allow"` significa
  "aceita o padrão", e o agente recebe a **primeira** opção.
- Então, para `AskUserQuestion`, o hook **não decide nada** e retorna na hora. A
  TUI desenha o seletor numerado, e o clique no card vira **um dígito** escrito no
  PTY.
- Dígito e não seta: seta é relativa e erra acumulado se um evento se perder;
  dígito é absoluto. O esquema da ferramenta limita a 4 opções, então um dígito
  sempre basta.
- Nada é lido da tela. O card e a TUI numeram a **mesma lista**, que veio
  estruturada no payload do hook.

Há uma folga de 400ms entre liberar o hook e escrever o dígito, porque o seletor
só existe depois que o hook retorna. Sem ela a tecla se perde.

### Nunca no settings.json global

`~/.claude/settings.json` é um arquivo só, e outras ferramentas moram nele (o Vibe
Island instala os hooks dele ali). O Prometheus escreve um settings por sessão em
`~/.prometheus/sessions/<uuid>/settings.json` e passa `claude --settings <arquivo>`.
Os dois rodam lado a lado sem se pisarem.

### Os scripts do repositório

Worktree separado só serve para editar até a hora de **testar**: worktree novo
vem sem nada que o `.gitignore` esconde — dependências, `.env`, banco, build.
Por isso o repositório declara três comandos, em `.prometheus/settings.toml`
(ou no `.conductor/settings.toml` que ele já tinha):

```toml
[scripts]
setup   = "npm install"                        # quando um worktree nasce
run     = "npm run dev -- --port $PROMETHEUS_PORT"   # o botão Run
archive = "docker compose down"                # antes de arquivar
```

O `setup` roda sozinho quando o worktree nasce, e a primeira mensagem do
lançador só é digitada ao agente depois que ele termina — agente que roda teste
antes do `npm install` conclui coisa errada. Se o setup falhar, a mensagem vai
mesmo assim, com um aviso na frente.

`run` também aceita a forma de vários, e aí o seletor ao lado do botão escolhe:

```toml
[scripts.run.web]
command = "bin/dev --port $PROMETHEUS_PORT"
default = true
```

No ambiente de todo script: `$PROMETHEUS_WORKSPACE_PATH`, `$PROMETHEUS_ROOT_PATH`,
`$PROMETHEUS_WORKSPACE_NAME` e `$PROMETHEUS_PORT` — mais os mesmos nomes com
prefixo `CONDUCTOR_`, para um settings.toml copiado de lá funcionar sem edição.

**A porta é o detalhe que faz a coisa toda funcionar.** Cada workspace guarda
dez portas suas, `$PROMETHEUS_PORT` até `+9`. Porta fixa no script faz o segundo
worktree não subir — e não subir dois é justamente não conseguir comparar duas
mudanças.

Nada disso é descoberto: o repositório declara. O que o Prometheus faz é não
deixar isso virar trabalho manual — a aba **Setup** de um repo que não declara
nada oferece **Perguntar ao agente**, que abre uma conversa com o prompt pronto
para o Claude Code ler o repositório e escrever o arquivo.

## Rodar

```sh
npm install
npm run app          # o app deste worktree, isolado (ver scripts/app.sh)
npm run dev          # só o front, no navegador, com um back falso — para mexer na UI
PORT=1421 npm run dev  # …e em outra porta, para dois lado a lado
```

Aponte um repositório git e um nome de branch, e clique em **Criar sessão**.

Na primeira vez em cada worktree novo o Claude Code pergunta se você confia na
pasta — responda no próprio terminal, ele está ali.

### Dois Prometheus ao mesmo tempo

`npm run app` passa por `scripts/app.sh`, que dá a este worktree porta,
`~/.prometheus-dev-<workspace>` e socket de hook próprios. Sem isso três coisas
colidem: a porta do vite (`strictPort`, e o segundo não sobe), o `board.json`, e
o socket — `socket::listen` apaga o órfão antes do `bind`, então o último a
subir rouba os hooks do primeiro.

O `.prometheus/settings.toml` deste repositório é o dogfooding: `run.app` sobe o
app de verdade deste worktree, e `run.browser` abre a mesma UI no Chrome sobre o
`src/mock.ts`. O segundo testa a tela e não o Rust, mas é o único caminho que um
Playwright dirige — a webview do Tauri no macOS é WKWebView e não fala CDP.

## Testes

```sh
cd src-tauri && cargo test
```

Cobre o ida-e-volta do hook, a garantia de que o app fora do ar não deixa o
agente pendurado, a leitura do settings.toml — e o contrato entre o front e os
**dois** backs: todo `invoke` de `src/*.ts` tem que existir no
`generate_handler!` e ter resposta no `src/mock.ts`. Sem essa checagem o mock
apodrece calado, devolvendo `null` para um comando que nasceu só do lado do Rust.

## Estado

Fatia vertical: **uma** sessão por vez, sem quadro, sem automação, sem preset.
Se o botão da pergunta não fosse bom, nada disso valeria — então ele veio primeiro.
