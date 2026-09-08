# Git do workspace

Status: implementado. O Git executa somente no Mac que possui o workspace.

## Responsabilidades

`src/workspace-changes.ts` controla seleção, rascunhos e apresentação. O backend
`src-tauri/src/session/git.rs` resolve o repositório pelo workspace e executa Git
com argumentos separados, sem shell. `src/diff.ts` empilha os arquivos do escopo
num scroll só, em diff unificado ou lado a lado, tanto em Alterações quanto em
comparação e commit. As duas apresentações conservam a numeração de cada lado;
lado a lado alinha os blocos de remoções e adições entre linhas de contexto.
O viewer existente continua responsável pela edição completa de arquivos,
acessível por **Abrir arquivo** ou pelo duplo clique no cabeçalho.

O painel mantém repositório, branch e remoto no cabeçalho, com contadores de
pull/push e um menu de ações. Abas explícitas separam Arquivos locais, Stage,
Histórico e Comparar. O formulário de commit fica somente em Stage; Arquivos
locais oferece uma entrada para revisar o índice. Histórico lista commits no
painel e mostra o selecionado no centro; Comparar mantém a referência editável.
Os grupos preservam seu estado ao atualizar o Git. Rótulos PT-BR mantêm os termos branch, commit e stage;
explicações das operações ficam nos tooltips, sem repetir instruções na lista.

Branch, etapa do workspace e status do agente são conceitos independentes.
Selecionar uma branch não troca o checkout de uma sessão em execução: abre um
workspace existente ou o lançador, com worktree obrigatório. Branch ocupada em
uma pasta sem workspace registrado mostra essa localização sem oferecer um
checkout sobre ela.

## Comandos IPC

Todos os comandos recebem `id`, identificador de workspace local. Os comandos
por repositório também recebem `repo`, índice em `Workspace.repos`. O backend
recusa workspace removido, devolvido, em preparação ou que falhou. Caminhos de
arquivo são relativos ao repositório selecionado; caminhos absolutos,
travessias, `.git` e pais que atravessam symlinks para fora são recusados.

| Comando | Argumentos adicionais | Retorno |
| --- | --- | --- |
| `workspace_git_status` | nenhum | `GitStatus[]` |
| `workspace_git_diff` | `repo`, `scope`, `path?`, `reference?` | `GitDiff` |
| `workspace_git_action` | `repo`, `operation`, `paths`, `message?`, `expected?`, `remote?` | vazio ou erro |
| `workspace_git_history` | `repo` | até 100 `GitCommit` |
| `workspace_git_branches` | `repo` | `GitBranch[]` |
| `workspace_git_conflict` | `repo`, `path` | versões atual, ours e theirs |
| `workspace_git_resolve` | `repo`, `path`, `was`, `text` | vazio ou erro |

Os tipos TypeScript ficam em `src/types.ts`. `src/ipc.ts`, o registro Tauri e
`src/mock.ts` expõem os mesmos comandos. Nenhum campo novo é persistido no
board; seleção e rascunhos duram enquanto o workspace existe na janela.

### Status e diffs

`GitStatus` contém identidade (`repo`, `name`, `branch`, `base`), upstream e
remotos, contadores `ahead`/`behind` em relação ao upstream, `has_head`,
`merging`, token opaco `index`, grupos `staged`/`changes`/`conflicts` e `error`.
Cada arquivo tem `path` e `status`. Um arquivo parcialmente preparado aparece
nos dois grupos, com comparações diferentes. Renomes aparecem como exclusão e
adição. O contador da aba conta caminhos locais únicos por repositório.

Status usa o formato porcelain delimitado por NUL. Um erro num repositório
não esconde os outros; a UI mantém o último status conhecido, apresenta o erro
e desabilita mutações naquele repositório. Projeto pode não ser repositório
git: o workspace nasce sem worktree e sem branch (`list_branches` responde
`git: false`, e o lançador trava as duas chavinhas), e o painel apresenta o
erro do Git como em qualquer repositório que não responde. Respostas antigas
não podem substituir a seleção de outro workspace ou repositório.

Sem upstream, os contadores são zero e a ação é **Publicar branch**. Isso não
significa que os commits estão publicados. HEAD destacado é `branch: null`;
leitura permanece disponível, mas commit, pull e push ficam bloqueados.

`GitDiff` contém `base` e `head` resolvidos e arquivos no formato `Change` já
usado pelo viewer de revisão. Os escopos são:

- `changes`: índice comparado ao worktree, incluindo arquivos não rastreados;
- `staged`: HEAD comparado ao índice, inclusive antes do primeiro commit;
- `compare`: merge base da referência escolhida com HEAD, até HEAD;
- `commit`: primeiro pai até o commit escolhido; commit inicial usa árvore vazia.

Comparação de branch e histórico excluem mudanças locais. Patches vazios
podem indicar binário, metadados ou limite de 400.000 bytes; a UI declara essa
limitação. O diff exibe até 2.500 linhas por arquivo e monta o corpo de cada um
conforme ele entra na área visível.

Alterações mostra um escopo por vez — `staged` ou `changes`, decidido pela aba
escolhida mesmo quando vazia —, porque o mesmo arquivo tem dois diffs diferentes.
Stage e Unstage não trocam essa aba. Clicar num arquivo do escopo já exibido
rola até ele e abre seu diff se estiver recolhido, sem refazer os outros patches.
O filtro por caminho afeta a lista e os diffs; **Adicionar tudo ao stage** e
**Remover tudo do stage** continuam operando sobre todo o escopo, incluindo arquivos
fora do filtro.

**Revisado** só registra a leitura: não prepara nem descarta conteúdo. A marca
existente no localStorage continua associada ao workspace, repositório, caminho
e fingerprint do patch. Mudanças no patch invalidam a marca. O progresso conta
todos os arquivos do escopo; **Próximo não revisado** limpa o filtro e abre o
próximo arquivo pendente. Layout e filtro são estado efêmero da janela.

### Mutações

`operation` aceita `stage`, `unstage`, `commit`, `fetch`, `pull`, `push` e
`publish`. Stage opera somente nos caminhos escolhidos, como pathspecs
literais. Unstage altera o índice e preserva os arquivos, inclusive antes do
primeiro commit. Não há stage automático ao commitar.

Commit exige mensagem, branch e índice preparado, ou merge pendente sem
conflitos. O token `expected` identifica HEAD e entradas do índice; mudanças
observadas entre a leitura e a operação exigem nova revisão. A leitura verifica
o token antes e depois de montar o status. Git mantém seus próprios locks;
operações externas e hooks continuam sendo participantes do repositório, não
processos controlados pela UI. O app serializa suas mutações e recusa outra
operação enquanto uma está em andamento.

Fetch atualiza remotos. Pull exige worktree e índice limpos, agente sem turno
em execução e avanço fast-forward, sem rebase ou autostash. Push envia apenas
HEAD à referência de upstream configurada. Publish exige um remoto conhecido e
configura o upstream da branch. Ambas as ações desativam `followTags`, não
fazem force-push e não publicam outros branches ou tags. Falhas preservam
rascunho e seleção; a UI atualiza o status após o resultado.

### Conflitos

O editor mostra versões de texto sem remover espaços ou quebras de linha.
O rascunho fica separado do arquivo atual. Resolver compara `was` com o texto
do disco, recusa alterações concorrentes observadas e marcadores de conflito,
grava o resultado e prepara o arquivo. Commit não ocorre automaticamente.
Escolher ours pode deixar o índice igual a HEAD; `merging` permite concluir
esse merge mesmo sem arquivos preparados.

Binários, symlinks e textos acima do limite não passam pelo editor de merge.
Podem ser resolvidos por ferramentas externas e preparados explicitamente.
Rebase/cherry-pick e outras operações avançadas continuam usando Git externo;
a interface não oferece uma ação genérica que conclua esses sequenciadores.

## Compatibilidade e evidência

`workspace_diff` mantém seu formato e comportamento anteriores para
consumidores existentes. A tela nova usa comandos separados, sem reinterpretar
silenciosamente o antigo `dirty` como estado de stage. Não há migração de board,
transcript ou protocolo de colaboração.

- `src-tauri/src/session/git_tests.rs`: repositórios Git reais, índice parcial,
  caminhos especiais, commit, remotos locais, conflitos e merge.
- `src/diff.test.ts`: numeração dos dois lados e alinhamento de substituições,
  adições e exclusões entre hunks.
- `e2e/git.spec.ts`: operações e estados da UI sobre o mock em Chromium e WebKit,
  incluindo revisão independente do stage, filtros, layout e rascunhos por repo.
- `e2e/critical-flows.spec.ts`: navegação ao viewer, revisão grande e isolamento
  entre repositórios.
- `src-tauri/tests/mock.rs`: paridade de comandos IPC.
