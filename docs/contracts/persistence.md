# Persistência local

Status: contrato atual.

## Princípios

- A sessão lógica sobrevive ao processo do agente.
- Estado e credenciais ficam fora dos worktrees.
- Apagar um worktree não apaga o histórico da conversa.
- Arquivos sensíveis nascem privados: diretórios `0700` e arquivos `0600` em
  plataformas Unix.
- Reescrita de estado usa arquivo temporário, sync e rename para não expor um
  arquivo truncado após falha.
- Formatos antigos ganham defaults e migrações; não são descartados por falta
  de campos novos.

## Raiz do app

Em release, a raiz padrão é `~/.prometeu`. Em debug, `~/.prometeu-dev`.
`PROMETEU_ROOT` pode substituir a raiz, principalmente em testes e instâncias
isoladas.

| Dado | Caminho | Ownership |
| --- | --- | --- |
| quadro | `<root>/board.json` | `state.rs` |
| backup do quadro | ao lado de `board.json` | `state.rs` |
| time e credencial | `<root>/team.json` | `team.rs` |
| conta opcional do Prometeu | `<root>/cloud.json` | `cloud.rs`; ver [contrato](cloud-account.md) |
| cache e vínculos do catálogo na nuvem | `<root>/catalog.json` (`catalog.local.json` é backup legado) | `catalog.rs`; ver [contrato](cloud-catalog.md) |
| skills instaladas e pacotes | `<root>/skills.json`, `<root>/skills-packages/<id>/` | `skills.rs`; ver [catálogo](cloud-catalog.md) |
| contas e seleção por provider | `<root>/accounts.json` | `accounts.rs` |
| perfis autenticados adicionais | `<root>/accounts/<uuid>/` | adapters Claude e Codex |
| último snapshot de cotas por conta | `<root>/usage.json` | `usage.rs` |
| transcript V1 do Codex | `<root>/chats/<tab>.jsonl` | `chat.rs` |
| arquivos recebidos por promessa nativa | `<root>/attachments/<uuid>/<nome>` | `file_drop.rs`; diretório privado `0700`, arquivo `0600` |
| hub de plugins | `<root>/plugins.json` | `plugins.rs` |
| home/marketplace Codex derivado | `<root>/codex-workspaces/<workspace-hash>/[<conta>/]` | `plugins.rs`; reconstruível |
| manifesto de importação | `<root>/imports/prometheus-v1.json` | `migration.rs` |
| snapshots da importação | `<root>/imports/prometheus-<data>-<id>/` | `migration.rs` |

Worktrees ficam em `~/prometeu/worktrees[-dev]/...`, fora da raiz de estado.

Arquivos prometidos (como a miniatura de uma captura) são materializados pelo
AppKit em um diretório novo por gesto, sem sobrescrever anexos anteriores.
O backend só entrega à UI arquivos existentes dentro desse diretório.
Não são removidos ao enviar a fala, encerrar a sessão ou apagar o worktree,
pois o transcript pode referenciar seus caminhos. Não há limpeza automática
nesta etapa. Arquivos normais do Finder continuam usando seus caminhos originais.
Essa pasta é aditiva: rollback ignora a pasta e preserva os caminhos já enviados;
nenhum formato existente exige migração.

O Prometeu não procura nem escreve automaticamente nas raízes do Prometheus.
Os dois aplicativos podem permanecer instalados e abertos sem compartilhar
estado antes da migração. A importação abaixo é explícita, cria backup e não
apaga a origem; depois dela, os worktrees adotados não devem ser operados pelos
dois aplicativos ao mesmo tempo.

## Importação do Prometheus

A importação é pedida explicitamente e só aceita um board de destino sem
projetos e workspaces. Ela lê `~/.prometheus/board.json` (ou seu backup quando o
principal estiver inválido), passa o conteúdo pelas mesmas normalizações de
compatibilidade do carregamento e grava o board por último.

Entram:

- projetos, workspaces, abas, branches, caminhos, issues e PRs do board;
- logs Codex de `~/.prometheus/chats/`, inclusive arquivos que já não estejam
  ligados a uma aba;
- cadastro e pastas de plugins gerenciados, com origens reescritas para a raiz
  do Prometeu;
- configurações de repositório cujo destino `.prometeu/settings.toml` ainda
  não exista.

Não entram `linear.json`, `team.json`, `usage.json`, `linear-issues.json`,
`sessions/`, `run/`, `codex-workspaces/` ou estado WebKit/localStorage. Workspaces
importados deixam de estar compartilhados até uma escolha nova da pessoa.

Os transcripts Claude permanecem em `~/.claude` e continuam sendo encontrados
porque o primeiro passo não muda os caminhos dos worktrees. Os arquivos do
Prometheus não são modificados. O manifesto registra versão, instante, hash do
board, ids, contagens e snapshot; estado `prepared` com todos os ids presentes
também conta como concluído, fechando a janela de queda entre gravar o board e
finalizar o manifesto.

## Board

`Board` contém projetos, estágios, workspaces e o catálogo opcional `actions`.
`Tab.task` guarda configuração resolvida e cursores das tarefas. Ausência desses
campos mantém as sessões anteriores. O catálogo recebe Code review uma única
vez, registrada em `actions.defaults_initialized`; ver [ações](actions.md). `Workspace` contém repositórios,
branch, worktree, configuração de agente, MCP/plugins, compartilhamento e abas.
`Tab.tokens` guarda uma estimativa incremental dos tokens usados na conversa;
`Tab.context_tokens` guarda o último contexto observado para somar somente o
crescimento. Quando o contexto cai após compactação, o novo valor inicia outro
trecho e soma ao total. Boards antigos sem `context_tokens` tratam `tokens` como
total e cursor inicial, sem duplicar o valor. A aba também contém identidade,
status, fala pendente, override de modelo e identidade externa usada para
resume quando necessário. `Tab.title` vazio é aba sem nome: a interface mostra
o modelo com quem ela fala. Boards antigos com o nome inventado `conversa` ou
`conversa N` são normalizados para vazio ao carregar.

Remover um projeto tira somente seu cadastro do quadro. Repositório, worktrees
e conversas não são apagados; workspaces ligados a ele aparecem em **Sem
projeto**. Ao carregar, somente workspaces legados sem o campo `project`
reconstituem o cadastro. Um id explícito sem projeto correspondente preserva a
remoção.

Ao carregar:

- valores de enum desconhecidos caem em estado seguro quando declarado por
  `serde(other)`;
- campos adicionados usam `serde(default)`;
- aliases preservam nomes antigos durante migração;
- estados runtime são reconciliados: processos não sobrevivem ao app.

Mudança que remove, renomeia ou altera semântica de campo persistido exige teste
com JSON da versão anterior.

## Ordered board publication

`Saver::publish` serializes snapshot creation, enqueueing, and the `board`
event under one publication mutex. It briefly locks the current board to clone
it, then releases the board lock before enqueueing and emission. Competing
publishers cannot enqueue or emit an older captured snapshot after a newer one.
The worker still coalesces writes and performs disk I/O outside the board lock.

`save_now` uses the same publication mutex and waits for a flush acknowledgment.
Flushing does not terminate the worker: action transitions also flush while
the app remains running. Later changes must still be persisted. Regression
coverage lives in `state.rs` (`concurrent_publications_keep_snapshot_and_emission_order`
and `flush_keeps_saver_available_for_runtime_publications`).

No board fields or serialization change. See
[ADR 0023](../decisions/0023-ordered-publication.md).

## Plugins derivados

O hub é a fonte de verdade do Prometeu. A cópia e o marketplace sob
`<root>/codex-workspaces/<workspace-hash>/marketplace/` são cache: carregam um
hash da origem, podem ser recriados e não entram no board. O mesmo diretório
contém um `config.toml` derivado que herda a configuração real e conserva a
confiança e o estado ativo dos hooks daquele workspace. A camada da conta original permanece nesse caminho;
contas gerenciadas recebem um subdiretório próprio. As demais entradas do
`CODEX_HOME` apontam para o perfil capturado no spawn. Cada perfil mantém sua
credencial, enquanto sessões, skills e cache de plugins continuam compartilhados. A configuração global não recebe marketplace nem
ativação do Prometeu. Remover o workspace do quadro ou devolver seu worktree
apaga essa camada derivada, sem seguir os links para o estado compartilhado. O
contrato completo está em
[`plugin-marketplace.md`](plugin-marketplace.md).

## Cotas

`usage.json` guarda por ID local de conta as janelas conhecidas e o instante
da última mudança. As chaves antigas `claude` e `codex` continuam identificando
os perfis originais, sem reescrever caches anteriores. O cadastro e a seleção
global estão em [`accounts.md`](accounts.md); não entram no board nem no relay. Cada janela tem tipo, percentual e reset. `scope` e `label` são
opcionais: snapshots antigos sem esses campos continuam sendo uma única cota;
snapshots novos usam `scope` para manter separadas cotas gerais e buckets de
modelo ou feature. O arquivo é cache: uma leitura válida do provider substitui
o conteúdo persistido.

## Transcripts

### Claude

O Claude Code grava em `~/.claude/projects/<slug-do-cwd>/<tab>.jsonl`, ou no
`projects` do `CLAUDE_CONFIG_DIR` original quando configurado. Perfis de contas
gerenciadas compartilham esse diretório por link; a seleção não muda o caminho
da conversa. A pasta deriva do caminho do worktree. O arquivo pode não existir até a primeira fala.

### Codex

O rollout nativo do Codex não é usado pela UI. O Prometeu grava os eventos V1
mostrados em `<root>/chats/<tab>.jsonl`; `Tab.agent_session` guarda a thread
opaca necessária para `thread/resume`.

### Compatibilidade

Leitura é tolerante a começo cortado e linhas inválidas isoladas. O buffer em
memória tem teto e corta somente em fronteira de linha. Eventos efêmeros de
streaming podem ser numerados sem serem persistidos quando a forma completa os
substitui.

`ConversationEventV1` mantém leitura do stream-json legado. Não há migração
destrutiva em lugar. O leitor reconhece e ignora a marca histórica
`prometheusV1Mirror`, necessária para uma importação futura de logs do produto
anterior; logs novos do Prometeu gravam somente o evento V1 canônico.

## Segredos e logs

Prompts, outputs, tool results e credenciais podem conter segredo. Não envie
transcripts para telemetria e não imprima tokens/configurações completas em
logs. Erros podem registrar caminho e causa, mas nunca conteúdo ou credencial.

## Escopo de compartilhamento

`Workspace.share_team` é opcional e prende o consentimento à organização e
matrícula (`organization:<id>:<member>`), ou ao time legado (`team:<id>`).
Ausência autoriza somente o caminho legado. `team.json` aceita o campo `cloud`
com identidade, origem e organização; tickets não são gravados. Antes de
substituir configuração legada, `team.rs` grava `team-legacy-<uuid>.json` privado.
Ver [migração e rollback](cloud-organizations.md).
