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
| identidades E2EE, vínculos TOFU e replay | `<root>/team-security.json` | `team.rs` (arquivo), `team-security.ts` (schema interno) |
| conta opcional do Prometeu | `<root>/cloud.json` | `cloud.rs`; ver [contrato](cloud-account.md) |
| cache e vínculos do catálogo na nuvem | `<root>/catalog.json` (`catalog.local.json` é backup legado) | `catalog.rs`; ver [contrato](cloud-catalog.md) |
| skills instaladas e pacotes | `<root>/skills.json`, `<root>/skills-packages/<id>/` | `skills.rs`; ver [catálogo](cloud-catalog.md) |
| contas e seleção por provider | `<root>/accounts.json` | `accounts.rs` |
| perfis autenticados adicionais | `<root>/accounts/<uuid>/` | adapters Claude e Codex |
| último snapshot de cotas por conta | `<root>/usage.json` | `usage.rs` |
| transcript V1 do Codex | `<root>/chats/<tab>.jsonl` | `chat.rs` |
| arquivos recebidos por promessa nativa | `<root>/attachments/<uuid>/<nome>` | `file_drop.rs`; diretório privado `0700`, arquivo `0600` |
| imagem colada da área de transferência | `<root>/attachments/<uuid>/pasted.png` | `file_drop.rs`; mesma pasta e permissões, TIFF convertido para PNG |
| hub de plugins | `<root>/plugins.json` | `plugins.rs` |
| home/marketplace Codex derivado | `<root>/codex-workspaces/<workspace-hash>/[<conta>/]` | `plugins.rs`; reconstruível |

Worktrees ficam em `~/prometeu/worktrees[-dev]/...`, fora da raiz de estado.

Arquivos prometidos (como a miniatura de uma captura) são materializados pelo
AppKit em um diretório novo por gesto, sem sobrescrever anexos anteriores.
O backend só entrega à UI arquivos existentes dentro desse diretório.
Não são removidos ao enviar a fala, encerrar a sessão ou apagar o worktree,
pois o transcript pode referenciar seus caminhos. Não há limpeza automática
nesta etapa. Arquivos normais do Finder continuam usando seus caminhos originais.
Essa pasta é aditiva: rollback ignora a pasta e preserva os caminhos já enviados;
nenhum formato existente exige migração.

O Prometeu não procura nem escreve nas raízes do Prometheus. Worktrees
adotados na migração antiga continuam em `~/prometheus/worktrees`; a limpeza de
um workspace multi-repo ainda aceita esse caminho, e os dois aplicativos não
devem operar a mesma pasta ao mesmo tempo.

## Preferência de som removida

A chave legada `prometeu:som` do localStorage deixa de ser lida ou escrita.
Se existir, permanece inerte; não há migração nem alteração de board ou
transcripts. Veja [ADR 0029](../decisions/0029-remove-alert-sound.md).

## Segurança da colaboração

`team-security.json` é aditivo, privado (`0600` em diretório `0700`), com escrita
atômica e limite de 8 MiB. O envelope é `{ version: 1, scopes: { ... } }`.
Cada escopo combina origem, organização/time, conta Cloud local e matrícula.
Contém identidade P-256 (JWK privada e chave pública), vínculos de membros,
sequência de anúncios, último dono/chave/revisão/ID por share, recibos de falas
remotas e relógio do último consumo. Limites: 64 vínculos, 4096 shares e 4096
recibos não expirados por escopo. Recibos expiram em até dois minutos.

Criação da identidade, primeiro vínculo, aceitação de chave, revisão e recibo
são gravados antes do uso correspondente. Corrupção, versão desconhecida e
falha de leitura/gravação bloqueiam colaboração; não regeneram chaves em
silêncio. Saída do time, troca de organização, logout e renovação de ticket
não removem o arquivo. As operações da webview são serializadas; a escrita
Rust usa o mesmo lock durante leitura/validação/gravação.

O arquivo contém segredos e não é backup cifrado nem chave de conteúdo no
servidor. Perdê-lo perde continuidade de TOFU e acesso aos comentários cifrados
para a identidade antiga. Um novo dispositivo exige aceitação da nova chave
pelos colegas. Rollback ignora e preserva o arquivo; nunca o converte em
credenciais v3. O mock de navegador guarda somente identidades fictícias em
localStorage e exercita o mesmo canal criptográfico.

Testes: `src/team-security.test.ts` e testes de `src-tauri/src/team.rs`.
Contrato de rede e limites: [relay v4](relay-v4.md).

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

`Workspace.remote_control`, falso por padrão, registra consentimento para os
dispositivos companheiros do dono. Ele é independente de `audience`: uma lista
vazia representa controle remoto sem audiência de time. Desligar o último tipo
de acesso também limpa `shared`, `share_team` e `audience`.
