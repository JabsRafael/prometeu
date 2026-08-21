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

## Rodar

```sh
npm install
npm run app          # tauri dev
npm run dev          # só o front, no navegador (localhost:1420) com um back falso — para mexer na UI
```

Aponte um repositório git e um nome de branch, e clique em **Criar sessão**.

Na primeira vez em cada worktree novo o Claude Code pergunta se você confia na
pasta — responda no próprio terminal, ele está ali.

## Testes

```sh
cd src-tauri && cargo test
```

Cobre o ida-e-volta do hook e a garantia de que o app fora do ar não deixa o
agente pendurado.

## Estado

Fatia vertical: **uma** sessão por vez, sem quadro, sem automação, sem preset.
Se o botão da pergunta não fosse bom, nada disso valeria — então ele veio primeiro.
