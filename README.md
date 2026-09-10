<p align="center">
  <img src="docs/icon.png" alt="" width="128" height="128">
</p>

<h1 align="center">Prometeu</h1>

Sessões de agente — Claude Code ou Codex — organizadas por workspace, cada uma
no seu worktree.

Conta Prometeu é opcional. O topo da barra lateral oferece cadastro pelo
navegador ou mostra nome e menu da conta conectada. O app funciona sem login;
esta primeira etapa não envia conversas para a nuvem. Ver
[contrato da conta](docs/contracts/cloud-account.md) e `e2e/cloud.spec.ts`.

O Cloud oferece **Catálogo** para cadastrar MCPs, plugins e skills pelo
navegador. O desktop recebe esses itens e conserva os seus cadastros locais.
Em **Configurações**, escolha **Compartilhar na nuvem** para sincronizar um
item ou **Criar cópia local** para personalizar sua definição neste Mac.
Instalação e seleção por conversa continuam explícitas; credenciais ficam
locais. Veja o [contrato do catálogo](docs/contracts/cloud-catalog.md).

Junta o que é bom no Conductor (worktree isolado por sessão, script de setup por
repo) com o que é bom no Vibe Island (você fica sabendo na hora que o agente
precisa de você), numa lista lateral que mantém cada trabalho à mão.

Clicar no nome de um projeto abre os arquivos do clone: a mesma árvore e o
mesmo editor de um workspace, no repositório como ele está, sem branch nova,
worktree nem conversa. Cada arquivo aberto vira aba, como num workspace, e o
"+" da barra é o mesmo do workspace: abre um terminal na pasta do clone, e a
setinha lista terminal novo ou workspace novo neste projeto. Setup e Run
continuam de fora, porque nenhum script é do clone. O centro fica vazio enquanto nenhuma aba
estiver aberta. É o
caminho curto para ler ou corrigir algo à mão; o chevron da ponta continua
recolhendo a lista do grupo. Cobertura: `e2e/critical-flows.spec.ts`.

Projeto não precisa ser um repositório git. Uma pasta solta entra na lista do
mesmo jeito, e o que muda é o lançador: worktree e branch nova ficam
desligados e travados, porque os dois são do git. A sessão abre na pasta como
ela está, com árvore, terminal, `@` de arquivo e conversa iguais. O painel Git
desse workspace diz que ali não há repositório.

Cada projeto tem um menu para removê-lo da lista. A remoção não apaga o
repositório, worktrees ou conversas; workspaces restantes ficam em **Sem
projeto**.

A barra lateral agrupa os workspaces por projeto. Um workspace com mais de um
repositório não pertence a um projeto só: ele mora em **Conjuntos**, abaixo dos
projetos, num grupo por combinação de repositórios que existe enquanto houver
workspace de pé, com o avatar dos projetos fatiado. Cada workspace mostra sua
branch e uma lista recolhível de agentes, uma linha por aba, com a marca do
provider e acesso direto à conversa. O indicador gira durante a execução,
fica verde quando a conversa está pronta, âmbar quando precisa de você e
cinza quando está desligada. O estado do agente não altera a etapa do trabalho.
Em sessões compartilhadas, o avatar identifica o dono, pois o relay não informa
o provider. Cobertura: fluxos da barra lateral em `e2e/critical-flows.spec.ts`.

Sessão é one-off: nasce, faz, morre. Sem passar artefato de uma sessão para outra.

Branches sugeridas usam duas palavras e quatro dígitos aleatórios, como
`prometeu/farol-quieto-0382`: 163.840.000 combinações. O app evita nomes já
listados nas branches locais e remotas. Cobertura: `src/branch.test.ts`.

## Documentação do projeto

- [`ARCHITECTURE.md`](ARCHITECTURE.md) é o mapa das responsabilidades e fluxos.
- [`docs/README.md`](docs/README.md) indexa contratos, decisões e operação.
- [`AGENTS.md`](AGENTS.md) é a entrada curta para agentes que trabalham no repo.

Este README descreve o produto e o comportamento visível. Contratos técnicos e
decisões arquiteturais têm fonte de verdade em `docs/`.

## Como funciona

Três camadas. Só a de cima é escrita com carinho.

```
tela (TS)      lista, abas, a conversa desenhada            <- seu
   ^  ConversationEventV1             v ConversationCommandV1
back (Rust)    normaliza, guarda, numera e repassa           <- cola
                                              v protocolo externo
processo       `claude -p` (stream-json) ou `codex app-server` (JSON-RPC)
```

O app **não reimplementa o agente**: roda o CLI de verdade, sem terminal, e
cada coisa que acontece — o texto que ele escreve, a ferramenta que chama, o
resultado dela, a permissão que pede — vira uma linha V1 do Prometeu. O back
(`src-tauri/src/chat.rs`) normaliza, guarda, numera e repassa; a tela as reduz
a uma linha do tempo (`src/timeline.ts`, um reducer puro) e desenha
(`src/chat.ts`): markdown, cards de ferramenta com o diff colorido, pensamento
dobrado. O que a TUI faria com escape codes, aqui é um reducer em cima de JSON.
Skills, MCP, `/compact`, `/context` continuam sendo do CLI — o que muda é só
quem desenha.

As fronteiras maiores ficam em módulos próprios: apresentação da conversa em
`src/chat-presentation.ts`, índice de mudanças em `src/workspace-changes.ts`,
transporte e controle remoto do time em `src/team-transport.ts` e
`src/team-control.ts`; no back, Git/diff e leitura de arquivos ficam em
`src-tauri/src/session/git.rs`, `src-tauri/src/session/diff.rs` e
`src-tauri/src/session/files.rs`. O contrato
da conversa e a compatibilidade com transcripts antigos ficam em
`src/conversation.ts`, `src/conversation-legacy.ts` e
`src-tauri/src/conversation.rs`.

Escolher um modelo GPT no lançador troca o processo por trás da aba pelo
`codex app-server`, e a tela não fica sabendo: `src-tauri/src/codex.rs` traduz
cada notificação dele (`item/started`, `item/agentMessage/delta`,
`turn/completed`…) para eventos canônicos, e cada comando da tela para a
chamada dele (`turn/start`, `turn/interrupt`). O que o Codex faz
diferente — o id de thread que ele escolhe, a conversa que o app grava porque
o rollout dele tem outra forma, os comandos de barra que são do app — está
explicado no cabeçalho desse arquivo. O catálogo de modelos sai do
`models_cache.json` do próprio `codex` (`src-tauri/src/agents.rs`).

### Git e mudanças

**Alterações** mantém abas explícitas para **Arquivos locais**, **Stage**,
**Histórico** e **Comparar** no painel direito. Os botões **Stage** e **Unstage**
preparam ou retiram arquivos do índice sem apagar o trabalho nem trocar a aba.
Um arquivo parcialmente preparado aparece nos dois escopos, cada um com seu
diff. A mensagem e o botão de commit ficam junto ao snapshot em Stage; o commit
inclui somente esse índice. Push continua separado, com upstream e contadores
visíveis. Conflitos permanecem acessíveis nos escopos locais.

O diff do grupo escolhido vem inteiro no centro, um arquivo embaixo do outro,
como uma revisão de PR: dá para ler tudo rolando. Clicar num arquivo da lista
rola até ele em vez de trocar a tela. O filtro reduz a lista e os diffs pelo
caminho. **Unificado** conserva as duas numerações; **Lado a lado** alinha
remoções e adições. **Abrir arquivo** leva ao viewer existente. **Revisado**,
o progresso e **Próximo não revisado** acompanham a leitura sem alterar o stage;
um patch que muda perde a marca de revisão.

O diff empilhado no centro é aba, e a aba é sua: ela entra na barra quando
você a abre — pelo segundo clique em **Alterações**, ou pelo **Revisar** — e sai
no ✕. Worktree sujo não a traz de volta; que há o que ver está no contador do
painel da direita.

**Histórico** lista commits no painel direito e abre o snapshot selecionado
no centro. **Comparar** mostra commits sem misturar edições locais.
A branch no cabeçalho abre a lista de branches e workspaces. Criar trabalho a
partir dali usa outro worktree; a sessão atual continua onde estava. O editor
de conflitos prepara o resultado revisado antes de concluir o merge.

Detalhes e limites estão em [`docs/contracts/git.md`](docs/contracts/git.md).
Cobertura: `src-tauri/src/session/git_tests.rs`, `src/diff.test.ts`,
`e2e/git.spec.ts` e os fluxos de revisão em `e2e/critical-flows.spec.ts`.

### A mesa

A tela inicial é a mesa: todas as conversas de pé, cada uma no seu quadro, com
a linha do tempo e a caixa de escrever — o mesmo que a tela do workspace
mostra, só que várias de uma vez. Dá para responder uma pergunta, aprovar um
plano ou mandar a próxima fala dali, sem entrar no workspace; a seta no
cabeçalho do quadro entra nele já naquela conversa. A alça do canto muda o
tamanho, o cabeçalho arrasta para trocar de lugar (um fantasma segue o cursor
e o quadro vira a vaga), e a faixa de cima lista todas as conversas: clicar
recolhe o quadro ou o traz de volta. Arquivo solto sobre um quadro vira anexo
daquela conversa, como na tela do workspace. Ordem, tamanho e o que está
recolhido ficam guardados neste Mac. Arquivado, worktree devolvido e conversa de colega
ficam de fora — cada um tem a sua tela.

Cobertura: `src/desk.test.ts` (a ordem guardada) e o fluxo Playwright da mesa
em `e2e/critical-flows.spec.ts`.

Conclusões, perguntas, permissões e comentários usam indicadores visuais,
sem avisos sonoros. A bolinha do Dock conta workspaces com pendências e
comentários na caixa de entrada. Não há opção de som nas Configurações.
Cobertura: `src/alert.test.ts` e `e2e/alerts.spec.ts`.

### O ida-e-volta

1. Uma fala é um comando `message.send`, traduzido na borda para o processo. Ele fica de
   pé entre um turno e outro — a sessão não é o processo, é o transcript no
   disco, e a próxima fala numa aba desligada o sobe de novo com `--resume`.
2. O que ele escreve no stdout vai para a tela e para o buffer da aba, cada
   linha com um número.
3. A lista lê o estado da mesma linha: ferramenta rodando é **rodando**,
   pedido de permissão é **quer você**, `result` é **pronta**, fim do processo
   é **desligada**. Não há hook nem socket: o stream já conta tudo.

### Anexar arquivos

Arraste arquivos do Finder ou a miniatura de uma captura de tela para a
conversa ou para um quadro da mesa, ou use o botão `+` da caixa de mensagem.
Os arquivos entram como anexos do rascunho,
sem apagar o texto; caminhos repetidos não criam anexos duplicados. No terminal,
soltar arquivos escreve os caminhos escapados para o shell.

A posição onde o arquivo é solto escolhe a conversa. Soltar fora das conversas
não anexa ao último chat visitado. Diálogos bloqueiam anexos nas conversas
atrás deles; o lançador recebe os anexos da primeira fala. Conversas remotas
não recebem arquivos deste Mac.

Miniaturas de captura usam uma promessa de arquivo do macOS. O app mostra
“Recebendo arquivo…” enquanto salva a captura numa pasta privada, e então
anexa à conversa escolhida, mesmo se você trocar de aba durante a espera.
O envio fica desabilitado até o recebimento terminar, para a fala não sair sem a captura.
Falhas de recebimento mostram um aviso e preservam o rascunho. Fontes que não
entregam caminho nem promessa de arquivo precisam salvar o arquivo antes do arraste.
Os testes em `e2e/file-drop.spec.ts` e `e2e/critical-flows.spec.ts` cobrem o
roteamento e os rascunhos em Chromium e WebKit sobre o mock; não substituem
um teste manual de arraste no app Tauri. Os arquivos recebidos ficam em
`~/.prometeu/attachments/`, fora do worktree, para continuarem disponíveis no histórico.

### Sempre solto

Toda sessão nasce com `--dangerously-skip-permissions`, sem chavinha. Nada
para para pedir, que é o que permite acompanhar várias sessões: agente que
trava a cada `Write` não trabalha enquanto você olha outra coisa. O worktree
separa as mudanças do Git e reduz acidentes no clone, mas não é sandbox: o
processo continua com o acesso do seu usuário ao Mac. Rodar **sem** worktree
ganha o aviso adicional em laranja porque o agente mexe direto no clone em que
você trabalha.

Mesmo solto, `AskUserQuestion` e `ExitPlanMode` continuam chegando — pelo
`--permission-prompt-tool stdio`, como `control_request` — e viram cards na
conversa. É deles que sai o **quer você** da lista.

### Modelo, esforço e plan mode

O rodapé do lançador é o do Conductor: modelo, esforço, **Plan** e o clipe de
anexar (ou soltar arquivo em cima da folha). Modelo e esforço viram `--model`
e `--effort` e ficam no workspace — ⌘T e retomar nascem com os mesmos.
"Modelo padrão" é não passar a flag. Esforço é uma escada de clique, Baixo a
Máximo e depois **Ultracode** (`--effort ultracode`: `xhigh` mais a
orquestração de workflows, para conta que a tem), e dá a volta.

Nada ali é `<select>`: o popup nativo do WKWebView não abre nesta janela (o
clique chega no elemento, o menu não vem), então modelo e projeto abrem o menu
do próprio app, o mesmo do botão direito no workspace da barra lateral.

**Plan** liga o plan mode na primeira conversa, e aqui tem uma sutileza
levantada na marra (Claude Code 2.1.240): `--permission-mode plan` junto de
`--dangerously-skip-permissions` nasce em bypass, e o plano nunca acontece. O
que funciona é `--permission-mode plan --allow-dangerously-skip-permissions`:
a sessão nasce em plan, o plano chega como card, e o "sim" manda antes um
`set_permission_mode` para bypass — senão a primeira ferramenta do plano já
pergunta de novo. No Codex o botão some: o app-server não expõe plan mode.

### MCP e plugins por workspace

MCP e plugins são escolhidos uma vez no workspace e acompanham a sessão tanto
no Claude Code quanto no Codex. O catálogo é o mesmo: o Claude recebe os itens
por flags e configuração estrita; para o Codex, o Prometeu cria um
marketplace local privado e um `CODEX_HOME` de configuração isolado para o
workspace. Conta, sessões, skills e cache continuam sendo os do Codex da pessoa,
mas a ativação dos plugins do Prometeu fica somente naquele workspace; o
`config.toml` global não é reescrito.

Uma pasta de plugin é o formato portátil. Ela pode trazer os manifests
`.claude-plugin/plugin.json` e `.codex-plugin/plugin.json`; plugins antigos só
com o primeiro são adaptados numa cópia, sem alterar a origem. Hooks do Codex
só recebem confiança quando pertencem ao plugin escolhido e seu hash atual é
conhecido; a seleção também os liga desde o `SessionStart`. Se um hook declarado
não puder nascer ativo, a conversa Codex não abre em um modo diferente do que a
pessoa escolheu. `.zip` e URL continuam disponíveis para sessões Claude e
mostram um erro antes do spawn se forem escolhidos com Codex. Skills, comandos,
MCP e hooks formam o subconjunto portátil; `agents/*.md` continua exclusivo do
Claude.

O instalador reconhece marketplaces `.agents/plugins/marketplace.json` e
`.claude-plugin/marketplace.json`. O contrato e as limitações estão em
[`docs/contracts/plugin-marketplace.md`](docs/contracts/plugin-marketplace.md).

### Pergunta, plano e permissão são cards

Os três chegam pelo mesmo cano (`control_request`) e viram cards na conversa:
a pergunta com uma aba por questão, como na TUI, e "Responder" só quando todas
estiverem; o plano em markdown com **sim**, **sim, perguntando** e **mudar**
(o que você escrever volta ao agente como a recusa); a permissão com o input
da ferramenta. Esc interrompe o turno. Um colega olhando a conversa responde
o mesmo card, e a resposta viaja até o Mac do dono.

### Contas e limites

Clique nas cotas de Claude ou Codex no rodapé para escolher a conta ativa,
ver os limites de cada conta ou adicionar outra assinatura. O rodapé mostra
apenas os limites; o e-mail fica no painel. O login começa no Prometeu
e termina no navegador oficial; depois, clicar na conta a ativa para todos os
workspaces daquele provider. O card inteiro é clicável, e um contorno indica
a conta ativa. Codex e Claude
mantêm seleções independentes, inclusive depois de fechar o app.

O turno atual termina com a conta anterior. A próxima mensagem usa a nova
conta e retoma a mesma conversa. Uma mensagem enviada durante a troca fica
na fila até o turno terminar. **Reconectar** renova um login; **Cancelar**
encerra uma tentativa em andamento. Conectar ou cancelar não muda a seleção.
O login já usado no terminal continua disponível e não é sobrescrito.

**Remover conta** tira qualquer conta do Prometeu, inclusive a do terminal.
Remover a conta ativa deixa aquele provider sem seleção até você escolher
outra. É possível remover todas; elas não reaparecem ao reiniciar. Isso não
faz logout do CLI nem apaga credenciais locais ou conversas. **Reconectar**
refaz o login no navegador, sem ser um botão de atualização das cotas.

Detalhes e evidências estão no [contrato de contas](docs/contracts/accounts.md).

### Onde a conversa dorme

A do Claude Code é o transcript dele, `~/.claude/projects/<slug>/<id>.jsonl`
— o app não escreve nele, só lê para reabrir a aba e para contar quanto o
contexto pesa. A do Codex o app grava, em `~/.prometeu/chats/<aba>.jsonl`,
nas mesmas linhas que a tela desenhou: o rollout do Codex tem outra forma, e o
id da thread dele fica no estado do workspace para o `thread/resume`.

### Migrar do Prometheus

Quem usava a instalação anterior encontra **Configurações → Aplicativo →
Migrar do Prometheus** enquanto o Prometeu ainda está vazio. A prévia conta
projetos, workspaces, conversas, plugins e configurações antes da confirmação.

O quadro e os históricos são copiados com backup; tokens e caches ficam de fora.
Os worktrees continuam em `~/prometheus/worktrees`, sem duplicar o que costuma
ser a maior parte do disco. Por isso o Prometheus deve ficar fechado depois da
troca: enquanto esses worktrees não forem limpos ou movidos, os dois aplicativos
apontam para as mesmas pastas Git.

### Os scripts do repositório

Worktree separado só serve para editar até a hora de **testar**: worktree novo
vem sem nada que o `.gitignore` esconde — dependências, `.env`, banco, build.
Por isso o repositório declara três comandos, em `.prometeu/settings.toml`
(ou no `.conductor/settings.toml` que ele já tinha):

```toml
[scripts]
setup   = "npm install"                        # when a worktree is created
run     = "npm run dev -- --port $PROMETEU_PORT"   # the Run button
archive = "docker compose down"                # before archiving
```

O `setup` roda sozinho quando o worktree nasce, e a primeira fala do lançador
só vai ao agente depois que ele termina — agente que roda teste antes do
`npm install` conclui coisa errada. Enquanto isso ela fica na tela, apagada,
e o que você escrever vai atrás dela. Se o setup falhar, a fala vai mesmo
assim, com um aviso na frente.

`run` também aceita a forma de vários, e aí o seletor ao lado do botão escolhe:

```toml
[scripts.run.web]
command = "bin/dev --port $PROMETEU_PORT"
default = true
```

No ambiente de todo script: `$PROMETEU_WORKSPACE_PATH`, `$PROMETEU_ROOT_PATH`,
`$PROMETEU_WORKSPACE_NAME` e `$PROMETEU_PORT` — mais os mesmos nomes com
prefixo `CONDUCTOR_`, para um settings.toml copiado de lá funcionar sem edição.
E `$PORT`, com o mesmo valor: é a convenção que Rails, Next, Express e o
Procfile do Heroku já leem, então um `npm run dev` digitado no terminal do dock
sobe na porta do worktree sem script nenhum.

**A porta é o detalhe que faz a coisa toda funcionar.** Cada workspace guarda
dez portas suas, `$PROMETEU_PORT` até `+9`. Porta fixa no script faz o segundo
worktree não subir — e não subir dois é justamente não conseguir comparar duas
mudanças. A porta sai do caminho do worktree, então o mesmo worktree ganha a
mesma porta em qualquer Prometeu — o instalado e o `tauri dev` de cada
worktree têm estados separados, e sem isso cada um entregava 3100 para o seu.

Worktree sem o arquivo usa o do clone de origem. É o que faz um `.prometeu/`
no `.gitignore` — configuração sua, num repositório de empresa — continuar
valendo em todo worktree que nasce dele; "Abrir o settings.toml" nesse worktree
copia o herdado para lá, e a cópia passa a mandar.

Nada disso é descoberto: o repositório declara. O que o Prometeu faz é não
deixar isso virar trabalho manual — a aba **Setup** de um repo que não declara
nada oferece **Perguntar ao agente**, que abre uma conversa com o prompt pronto
para o Claude Code ler o repositório e escrever o arquivo.

**Setup** e **Run** ficam no painel da direita, que é onde a saída deles se
acompanha de canto enquanto você fala com o agente. O terminal livre, não: ele
é aba do centro, ao lado das conversas e do navegador — é onde se digita, e
digitar pede a tela. A setinha ao lado do **+** abre um shell novo no worktree;
sair da aba não mata nada, e ⌘W com o cursor dentro dele fecha o terminal.
Teste em `e2e/critical-flows.spec.ts`.

### Os arquivos do worktree

A aba **Arquivos** do painel da direita é a árvore do worktree, e clicar num
arquivo o abre no centro, no lugar da conversa. Código abre pronto para
escrever, com ⌘S para salvar e Esc para desistir; se o agente mexeu no arquivo
enquanto você editava, salvar recusa em vez de passar por cima. PDF abre com
rolagem e zoom, página a página. CSV vira tabela com cabeçalho fixo: o
separador é adivinhado pela primeira linha (`;` do Excel em pt-BR, tab ou
vírgula), campo entre aspas com vírgula ou quebra de linha dentro fica
inteiro, arquivo latin-1 não vira caractere quebrado, e as linhas entram aos
lotes conforme a rolagem — um CSV de cem mil linhas abre sem travar a janela.
PDF e CSV são só leitura. Testes em `src/csv.test.ts` e nos testes Rust de
`src-tauri/src/session/files.rs`.

## A dois na mesma conversa

Um time, e dentro dele sessões compartilhadas: o colega vê a conversa
inteira, ao vivo, fala nela, responde os cards e deixa comentários persistentes
sobre o trecho que quer discutir.

```
Mac do dono                        relay (Worker + 1 DO por time)        Mac do colega
evento `chat` ──► linhas JSON ──►  presença · shares · quem olha    ──►  a mesma conversa
chat_send    ◄──  fala/card   ◄──  comentários · "Para mim"        ◄──  o que ele escreve
```

**A sessão continua rodando só no Mac do dono.** Não há VM, não há sessão na
nuvem: o `claude` é o mesmo processo de sempre, no worktree de sempre. O relay
só coordena — repassa frames e guarda o pouco que precisa sobreviver a alguém
estar offline (membros, o que está compartilhado, os comentários). Dono fora do ar =
conversa congelada para os outros, e o card diz isso.

**O conteúdo compartilhado usa criptografia ponta a ponta.** Conversas,
falas remotas, comentários, citações e títulos são cifrados nos dispositivos.
A configuração é automática: o app aceita a primeira chave de cada membro e a
conserva localmente. Trocas de chave bloqueiam conteúdo com aquele membro até
revisão em **Configurações / Organizações**. Códigos de segurança podem ser
comparados por outro canal; isso é opcional.

O relay ainda vê membros, destinatários, IDs, menções, presença, horários e
tamanhos. Um servidor malicioso no primeiro contato pode substituir uma chave.
Não há forward secrecy: roubar uma chave privada pode expor conteúdo antigo
gravado para ela. Um segundo Mac usa o fluxo de troca de chave, sem sincronização
automática do histórico. Não equivale às garantias do WhatsApp nem protege um
Mac comprometido ou prompts enviados aos providers. Veja o [ADR 0022](docs/decisions/0022-end-to-end-encryption.md).

App e relay precisam de v4; não há fallback em texto. Dados v3 permanecem no
relay, mas comentários v3 não aparecem no cliente novo. Fora da máquina local,
o app continua exigindo HTTPS/WSS.

Quem fala com o relay é o **front**. O Rust guarda credenciais e obtém tickets
curtos usando a conta conectada. Organizações e convites são administrados no
Prometeu Cloud; o processo do agente continua local.

### A organização

No Cloud, abra **Organizações**, crie a organização e convide pessoas por email.
A pessoa precisa verificar o email e aceitar explicitamente o convite. Dono e
administradores gerenciam membros e o catálogo compartilhado de MCPs, plugins e
skills. Membros podem copiar definições para o catálogo pessoal recebido pelo desktop.
As cópias são independentes e nunca substituem um item homônimo no destino.

No desktop, **Configurações / Organizações** seleciona uma matrícula já aceita.
Quando existe uma única organização aceita, o desktop já a deixa ativa; sair
dela desliga esse atalho naquele Mac. Compartilhe cada workspace por escolha.
Trocar de organização ou conta não publica compartilhamentos antigos para
novas pessoas. Times legados continuam
funcionando; a troca para organização conserva backup de `team.json`.
Ver [contrato e migração](docs/contracts/cloud-organizations.md).

### A sessão ao vivo

Na barra de um workspace seu: **Compartilhar**. Ele aparece em
"Compartilhados" na barra lateral dos colegas, com o seu nome. Abrir mostra a conversa
inteira e o que chega ao vivo; a caixa de escrever está liberada. Você vê quem
está olhando cada conversa em chips ao lado do estado.

Falas de colegas entram identificadas pelo nome. Respostas a cards passam por
uma segunda validação no Mac do dono: só respondem um pedido realmente aberto,
reutilizam o input que o dono viu e não podem ativar modo irrestrito.

Duas coisas fazem isso funcionar sem coordenação nenhuma:

- **cada linha sai numerada** (`Lines`, em `chat.rs`), e a conversa que o dono
  manda a quem acabou de abrir vem com "até a linha N" — então o colega
  descarta o que já estava dentro dela e emenda o resto. Ela vai em partes,
  cortadas em linha inteira, porque o relay limita cada mensagem a 1 MB e a
  aba guarda até 4;
- **o dono só transmite a aba que alguém está olhando.** Sem espectador, o
  custo é zero — o que importa porque o relay cobra por mensagem recebida.

O colega desenha no tamanho da janela dele: são as mesmas linhas, e o mesmo
reducer dos dois lados. Fora do que viaja: o dock (setup/run/shells).

### Os comentários

Comentário não é fala para o agente: é uma conversa entre pessoas **sobre** a
sessão. Ele fica no painel direito, fora do transcript, até alguém o resolver.
Cada comentário pode ter respostas e estado explícito: **aberto** ou
**resolvido**.

A caixa principal sempre fala com o agente. Para comentar, selecione um trecho
e use ⌘⇧M, ou clique em **Comentar** numa resposta. O rascunho abre no painel
com uma citação e uma âncora estável para aquele trecho; o marcador na conversa
leva de volta à thread. Também é possível criar um comentário geral da aba.

`@` abre a lista do time. Quem foi marcado ganha **Para mim** na barra, mesmo
que estivesse offline. Abrir o comentário não o tira dali: ele permanece até a
thread ser resolvida para todos. ⌘↵ envia; Enter quebra linha.

### No celular

O Cloud serve o Prometeu em `/app`: uma página que entra na organização como
um dispositivo seu, com chave própria, e mostra o que colegas ou o seu Mac
compartilharam. Dá para abrir a conversa, mandar uma mensagem para o agente no
Mac do dono, comentar e ver o "Para mim". A conversa continua rodando só no
Mac, que precisa estar acordado e com o Prometeu aberto. Adicione a página à
tela inicial para usar como app. Remover o dispositivo fica em Configurações →
Dispositivos no Cloud.

No rodapé de uma conversa local, **Controle remoto** libera ou revoga somente
seus dispositivos. Essa permissão não compartilha o workspace com outras
pessoas e não muda a audiência escolhida em **Compartilhar**.

### O relay

Mora em `relay/`: um Worker que cria times e encaminha cada conexão ao Durable
Object daquele time. Toda decisão está em `relay/src/logic.ts`, um `reduce`
puro; `room.ts` converte WebSocket em evento e efeito em `send`/`storage`. Além
dos testes puros, a suíte sobe o Worker local e confere matrícula e autenticação
reais. Sobe uma vez:

```sh
npm run relay:deploy   # precisa de `wrangler login`
npm run relay:dev      # ou o relay local, em ws://127.0.0.1:8787
```

Para organizações locais, configure `RELAY_URL=http://127.0.0.1:8787` no Cloud,
`CLOUD_URL=http://127.0.0.1:3100` em `relay/.dev.vars` e
`PROMETEU_CLOUD_URL=http://127.0.0.1:3100` no desktop. `VITE_RELAY` continua
configurando somente o caminho de times legados. Publicação exige atualizar
Cloud, relay e desktop nessa ordem; testes locais não fazem deploy.

## Rodar

```sh
npm install
npm run app          # o app deste worktree, isolado (ver scripts/app.sh)
npm run dev          # só o front, no navegador, com um back falso — para mexer na UI
PORT=1421 npm run dev  # …e em outra porta, para dois lado a lado
```

Aponte um repositório git e um nome de branch, e clique em **Criar sessão**.
Uma pasta sem git também serve: a sessão abre nela, sem worktree nem branch.

### Dois Prometeu ao mesmo tempo

`npm run app` passa por `scripts/app.sh`, que dá a este worktree porta e
`~/.prometeu-dev-<workspace>` próprios. Sem isso duas coisas colidem: a
porta do vite (`strictPort`, e o segundo não sobe) e o `board.json`.

O `.prometeu/settings.toml` deste repositório é o dogfooding: `run.app` sobe o
app de verdade deste worktree, e `run.browser` abre a mesma UI no Chrome sobre o
`src/mock.ts`. O segundo testa a tela e não o Rust, mas é o único caminho que um
Playwright dirige — a webview do Tauri no macOS é WKWebView e não fala CDP.

## Testes

```sh
npx playwright install chromium webkit  # uma vez nesta máquina
npm test                       # web, relay, Rust e cinco fluxos de navegador
```

Cobre o que erra calado:

- a linha do tempo da conversa (`src/timeline.ts`): o rascunho do streaming
  virando a linha inteira, o resultado achando a ferramenta, o card que fecha
  quando alguém responde, a compactação, as tarefas em segundo plano, o
  transcript reaberto que não pode terminar "chegando";
- o protocolo V1 (`src/conversation.test.ts` e `conversation.rs`): parser,
  equivalência de replay, evento desconhecido e espelho de rollback;
- o tradutor do Codex (`codex.rs`) contra as formas que o app-server manda de
  verdade: a numeração dos blocos, o diff montado do `fileChange`, a pergunta
  que volta no id certo, o `/compact` com antes e depois, a retomada que cai
  para conversa nova;
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
- o **relay** pela lógica pura (audiência, cotas, quem recebe o quê, dono que
  cai e volta, menção que vira caixa) e no runtime local do Worker (matrícula,
  credencial individual e recusa do protocolo antigo), o formato dos frames
  binários e a regra de juntar a rolagem do dono com os pedaços ao vivo;
- cinco fluxos Playwright sobre o mock: criação pelo lançador, pergunta e
  resposta de card, comentário persistente, troca rápida de abas com snapshot
  atrasado e recolhimento da saída técnica de ferramentas que falharam.

## Estado

Uma lista de workspaces, cada um num worktree, com várias conversas dentro. A
etapa é sua e o estado é do agente — dois eixos que não se misturam. Com time,
a lista também traz o workspace de um colega: a conversa dele ao vivo e as
threads de comentários ao lado dela.

Se o botão da pergunta não fosse bom, nada disso valeria — então ele veio
primeiro.

## Ações e agentes reutilizáveis

Em **Configurações › Ações**, **Code review** já vem configurado: `/review`
abre uma revisão das alterações em outra aba, sem modificar arquivos ou publicar
PR. O perfil é editável e removível. Cadastre também comandos que preenchem um prompt editável
ou iniciam um agente em outra aba. Use `/nome` no chat ou o menu **Ações**.
Perfis configuram modelo, esforço, prompt, MCP, plugins, skills e permissões;
projetos podem personalizar o perfil global. Cada execução mantém sua configuração.

O exemplo **Responsável pela PR** revisa, publica e acompanha a entrega na mesma
sessão. O software consulta GitHub; o agente só recebe turno quando há comentários
ou resultados de CI novos. Requer `gh` autenticado e app aberto. Intervalo, eventos
e limite de turnos são configuráveis. O controle na conversa pausa ou retoma o
acompanhamento. O botão Open PR pode usar uma ação ou manter o comportamento atual.

Detalhes e limites no [contrato de ações](docs/contracts/actions.md). Testes em
[actions.test.ts](src/actions.test.ts), [actions.rs](src-tauri/src/actions.rs) e
[actions.spec.ts](e2e/actions.spec.ts).

## Feedback

O botão **Feedback** recebe problemas, ideias e outros relatos. Você pode anexar
uma imagem ou capturar uma janela e revisar a miniatura antes de enviar.
Feedback é tratado em privado pela equipe Prometeu. Revise a captura e remova
senhas e outros dados sensíveis antes de enviar.
A entrega depende da configuração do Cloud. Veja o [contrato](docs/contracts/feedback.md).
