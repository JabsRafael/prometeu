<p align="center">
  <img src="docs/icon.png" alt="" width="128" height="128">
</p>

<h1 align="center">Prometheus</h1>

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

### Sempre solto

Toda sessão nasce com `--dangerously-skip-permissions`, sem chavinha. Nada
para para pedir, que é o que faz o quadro valer a pena: agente que trava a
cada `Write` não trabalha enquanto você olha outra coisa. Vale porque o
worktree é isolado e descartável — e é por isso que solto **sem** worktree é o
único par que merece aviso, e o lançador o dá em laranja: aí o agente mexe sem
pedir no clone em que você trabalha.

O hook de `PermissionRequest` fica instalado mesmo assim, porque
`AskUserQuestion` e `ExitPlanMode` passam por ele em bypass.

### Modelo, esforço e plan mode

O rodapé do lançador é o do Conductor: modelo, esforço, **Plan** e o clipe de
anexar (ou soltar arquivo em cima da folha). Modelo e esforço viram `--model`
e `--effort` e ficam no workspace — ⌘T e retomar nascem com os mesmos.
"Modelo padrão" é não passar a flag. Esforço é uma escada de clique, Baixo a
Máximo e depois **Ultracode** (`--effort ultracode`: `xhigh` mais a
orquestração de workflows, para conta que a tem), e dá a volta.

Nada ali é `<select>`: o popup nativo do WKWebView não abre nesta janela (o
clique chega no elemento, o menu não vem), então modelo e projeto abrem o menu
do próprio app, o mesmo do botão direito no card.

**Plan** liga o plan mode na primeira conversa, e aqui tem uma sutileza
levantada na marra (Claude Code 2.1.240): `--permission-mode plan` junto de
`--dangerously-skip-permissions` nasce em bypass, e o plano nunca acontece. O
que funciona é `--permission-mode plan --allow-dangerously-skip-permissions`:
a sessão nasce em plan, e o "Would you like to proceed?" do `ExitPlanMode` já
traz "switch to BYPASS PERMISSIONS" como primeira opção. O card **plano
pronto** mostra o plano; **Executar** é o dígito `1` escrito no PTY, e daí em
diante é o solto de sempre. **Ajustar** é o `3`, e o terminal ganha o foco para
você dizer o que muda.

`ExitPlanMode` passa pelo hook como qualquer ferramenta, mas `allow` por ele
não pula o seletor — a TUI o desenha do mesmo jeito, só mais tarde. Então o
hook o solta na hora, como faz com `AskUserQuestion`.

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
npm test      # os dois lados
```

Cobre o que erra calado:

- o ida-e-volta do hook, e a garantia de que o app fora do ar não deixa o agente
  pendurado;
- o contrato entre o front e os **dois** backs: todo `invoke` de `src/*.ts` tem
  que existir no `generate_handler!` e ter resposta no `src/mock.ts`. Sem essa
  checagem o mock apodrece calado, devolvendo `null` para um comando que nasceu
  só do lado do Rust;
- que **encerrar uma sessão encerra mesmo** — o filho que ignora o desligamento
  educado e o neto que o filho deixou para trás, que é o `node` do servidor de
  dev segurando a porta depois de você mandar fechar;
- a **gramática do seletor** — quais teclas respondem um `AskUserQuestion`. É a
  única parte do projeto que adivinha o estado de uma TUI, então é a que mais
  precisa de um teste dizendo o que era verdade quando funcionou;
- a leitura do settings.toml, e a base de onde a branch nova sai, contra um git
  de verdade;
- o corte de um `git diff` em um patch por arquivo, e a conta de número de linha
  que o front faz em cima dele.

## Estado

Um quadro de workspaces, cada um num worktree, com várias conversas dentro. A
etapa é sua e o estado é do agente — dois eixos que não se misturam.

Se o botão da pergunta não fosse bom, nada disso valeria — então ele veio
primeiro.
