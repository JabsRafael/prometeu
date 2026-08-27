<p align="center">
  <img src="docs/icon.png" alt="" width="128" height="128">
</p>

<h1 align="center">Prometheus</h1>

Quadro Kanban global por cima de sessões de agente — Claude Code ou Codex —,
cada uma no seu worktree.

Junta o que é bom no Conductor (worktree isolado por sessão, script de setup por
repo) com o que é bom no Vibe Island (você fica sabendo na hora que o agente
precisa de você), e adiciona a etapa que **você** arrasta.

Sessão é one-off: nasce, faz, morre. Sem passar artefato de uma sessão para outra.

## Como funciona

Três camadas. Só a de cima é escrita com carinho.

```
overlay (TS)   quadro, abas, notificação                    <- seu
   ^  clique                                    v evento
hooks (socket) prometheus-hook <-> prometheus.sock          <- cola
                                                v payload
PTY            o `claude` de verdade, TUI inteira           <- de graça
```

O app **não reimplementa nada** do Claude Code. Roda o CLI de verdade num
pseudo-terminal e intercepta só os momentos que merecem UI nativa. Todo comando,
autocomplete, plan mode, skill e release novo continuam funcionando porque é o
Claude Code de verdade rodando ali.

Escolher um modelo GPT no lançador troca o CLI da aba pelo `codex`, e nada disso
muda: os hooks do Codex mandam os mesmos eventos, com os mesmos campos, pelo
mesmo socket. O que muda está no `src-tauri/src/agents.rs` — as flags de modelo e
esforço, o id de sessão que ele não deixa impor, e o `hooks.json` que não é por
sessão.

### O ida-e-volta

1. O Claude Code dispara um hook — `PreToolUse`, `Stop`, `PermissionRequest`, …
2. `prometheus-hook` lê o payload no stdin e o entrega pelo socket unix.
3. O app anota no quadro o que aquela sessão está fazendo, ou que ela parou
   esperando você, e solta o hook na hora.

O app **não responde** por você: pergunta, plano e permissão são seletores da
TUI, e é dentro do terminal que se responde. O hook serve para o quadro saber o
que está acontecendo em cada conversa sem você abrir uma por uma.

Uma conexão por invocação de hook, então a conexão já é a correlação: sem ids de
mensagem, sem multiplexação.

### Sempre solto

Toda sessão nasce com `--dangerously-skip-permissions`, sem chavinha. Nada
para para pedir, que é o que faz o quadro valer a pena: agente que trava a
cada `Write` não trabalha enquanto você olha outra coisa. Vale porque o
worktree é isolado e descartável — e é por isso que solto **sem** worktree é o
único par que merece aviso, e o lançador o dá em laranja: aí o agente mexe sem
pedir no clone em que você trabalha.

O hook de `PermissionRequest` fica instalado mesmo assim: `AskUserQuestion` e
`ExitPlanMode` passam por ele em bypass, e é dele que sai o **quer você** do
quadro.

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
traz "switch to BYPASS PERMISSIONS" como primeira opção. Aprovar o plano é
responder esse seletor no terminal; o quadro só conta que a conversa parou
esperando você.

### Perguntar é da TUI

O app já desenhou card de pergunta, de plano e de permissão por cima do
terminal. Não desenha mais: a TUI do Claude Code desenha os mesmos seletores
logo ali embaixo, com o texto inteiro e o teclado que você já conhece, e a
segunda cópia só disputava atenção com a primeira. O hook solta o agente na
hora nos três casos, e o que sobra no app é a nota **quer você** no card do
workspace — que é a parte que o terminal não conta quando você está olhando
outra conversa.

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
E `$PORT`, com o mesmo valor: é a convenção que Rails, Next, Express e o
Procfile do Heroku já leem, então um `npm run dev` digitado no terminal do dock
sobe na porta do worktree sem script nenhum.

**A porta é o detalhe que faz a coisa toda funcionar.** Cada workspace guarda
dez portas suas, `$PROMETHEUS_PORT` até `+9`. Porta fixa no script faz o segundo
worktree não subir — e não subir dois é justamente não conseguir comparar duas
mudanças. A porta sai do caminho do worktree, então o mesmo worktree ganha a
mesma porta em qualquer Prometheus — o instalado e o `tauri dev` de cada
worktree têm quadros separados, e sem isso cada um entregava 3100 para o seu.

Worktree sem o arquivo usa o do clone de origem. É o que faz um `.prometheus/`
no `.gitignore` — configuração sua, num repositório de empresa — continuar
valendo em todo worktree que nasce dele; "Abrir o settings.toml" nesse worktree
copia o herdado para lá, e a cópia passa a mandar.

Nada disso é descoberto: o repositório declara. O que o Prometheus faz é não
deixar isso virar trabalho manual — a aba **Setup** de um repo que não declara
nada oferece **Perguntar ao agente**, que abre uma conversa com o prompt pronto
para o Claude Code ler o repositório e escrever o arquivo.

## A dois no mesmo terminal

Um time, e dentro dele sessões compartilhadas: o colega vê **tudo** o que
está rolando no terminal, ao vivo, digita nele, e deixa nota citando o trecho
que quer discutir.

```
Mac do dono                       relay (Worker + 1 DO por time)        Mac do colega
evento `pty` ──► saída (bin) ──►  presença · shares · quem olha    ──►  xterm ao vivo
pty_write   ◄──  tecla       ◄──  notas · caixa "para mim"         ◄──  o que ele digita
```

**A sessão continua rodando só no Mac do dono.** Não há VM, não há sessão na
nuvem: o `claude` é o mesmo processo de sempre, no worktree de sempre. O relay
é burro — repassa frames e guarda o pouco que precisa sobreviver a alguém
estar offline (membros, o que está compartilhado, as notas). Dono fora do ar =
terminal congelado para os outros, e o card diz isso.

Quem fala com o relay é o **front**: ele já recebe todo byte de todo terminal
e já sabe escrever neles. O back só guarda `~/.prometheus/team.json` (`0600`)
e a marca de "compartilhado" no quadro.

### O time

Configurações → **Time**: criar gera o código de convite
(`pm1.<time>.<segredo>`); entrar é colar o código e dizer seu nome. Quem tem o
código entra e digita em qualquer sessão compartilhada — é o modelo "pessoas
de confiança", e trocar o segredo é criar outro time.

### A sessão ao vivo

Na barra de um workspace seu: **Compartilhar com o time**. Ele aparece no
quadro dos colegas ("Compartilhados com você", e "Do time" na barra lateral),
com o seu nome no card. Abrir mostra o terminal com a rolagem inteira e a
saída ao vivo; o teclado está liberado. Você vê quem está olhando cada
conversa em chips ao lado do estado.

Duas coisas fazem isso funcionar sem coordenação nenhuma:

- **cada pedaço da saída sai numerado** (`Scroll`, em `pty.rs`), e a rolagem
  que o dono manda a quem acabou de abrir vem com "até o pedaço N" — então o
  colega descarta o que já estava dentro dela, mesmo quando o dono junta 40 ms
  de saída num frame só. Sem número, ou o dono não podia juntar, ou o colega
  via um trecho duas vezes;
- **o dono só transmite a aba que alguém está olhando.** Sem espectador, o
  custo é zero — o que importa porque o relay cobra por mensagem recebida.

O tamanho é o do terminal do dono: o colega desenha nele e rola se não couber.
Fora do que viaja: dock (setup/run/shells) e os cards de pergunta, plano e
permissão — a TUI do Claude Code já desenha tudo dentro do terminal, e o
colega responde ali como o dono responderia.

### As notas

Nota não é fala para o agente: é recado entre pessoas **sobre** a sessão, no
painel do lado. O caso que ela resolve é o agente levantar uma dúvida de
desenho e você precisar de alguém para responder.

A âncora é a **citação** — o trecho selecionado no terminal (⌘⇧M, ou o botão
que aparece quando há seleção). `@` abre a lista do time; quem foi marcado
ganha **Para mim** na barra, com a nota, mesmo que estivesse offline. ⌘↵
envia; Enter quebra linha.

### O relay

Mora em `relay/`: um Worker que cria times e encaminha cada conexão ao Durable
Object daquele time. Toda decisão está em `relay/src/logic.ts`, um `reduce`
puro que o vitest exercita sem miniflare; `room.ts` só converte WebSocket em
evento e efeito em `send`/`storage`. Sobe uma vez:

```sh
npm run relay:deploy   # precisa de `wrangler login`
npm run relay:dev      # ou o relay local, em ws://127.0.0.1:8787
```

Com o relay local, `VITE_RELAY=ws://127.0.0.1:8787` aponta o app (ou o
navegador sobre o `src/mock.ts`) para ele, e dois deles testam o
compartilhamento de ponta a ponta. Sem relay publicado, o app não tem padrão:
a URL vai à mão em Configurações → Time → Relay.

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
- a leitura do settings.toml, e a base de onde a branch nova sai, contra um git
  de verdade;
- o corte de um `git diff` em um patch por arquivo, e a conta de número de linha
  que o front faz em cima dele;
- o **relay** inteiro pela lógica pura (segredo errado recusado, quem recebe o
  quê, dono que cai e volta, menção que vira caixa), o formato dos frames
  binários, e a regra de juntar a rolagem do dono com os pedaços ao vivo
  (`src/mirror.ts`) — que é o que erra calado: trecho repetido, trecho perdido.

## Estado

Um quadro de workspaces, cada um num worktree, com várias conversas dentro. A
etapa é sua e o estado é do agente — dois eixos que não se misturam. E, com
time, o quadro de um colega também: a sessão dele ao vivo, e as notas ao lado.

Se o botão da pergunta não fosse bom, nada disso valeria — então ele veio
primeiro.
