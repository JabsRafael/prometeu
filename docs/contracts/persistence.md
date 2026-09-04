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

Em release, a raiz padrão é `~/.prometheus`. Em debug, `~/.prometheus-dev`.
`PROMETHEUS_ROOT` pode substituir a raiz, principalmente em testes e instâncias
isoladas.

| Dado | Caminho | Ownership |
| --- | --- | --- |
| quadro | `<root>/board.json` | `state.rs` |
| backup do quadro | ao lado de `board.json` | `state.rs` |
| time e credencial | `<root>/team.json` | `team.rs` |
| último snapshot de cotas | `<root>/usage.json` | `usage.rs` |
| transcript V1 do Codex + espelho de rollback | `<root>/chats/<tab>.jsonl` | `chat.rs` |

Worktrees ficam em `~/prometheus/worktrees[-dev]/...`, fora da raiz de estado.

## Board

`Board` contém projetos, estágios e workspaces. `Workspace` contém repositórios,
branch, worktree, configuração de agente, MCP/plugins, compartilhamento e abas.
`Tab` contém identidade, status, fala pendente, tokens, override de modelo e a
identidade externa usada para resume quando necessário.

Ao carregar:

- valores de enum desconhecidos caem em estado seguro quando declarado por
  `serde(other)`;
- campos adicionados usam `serde(default)`;
- aliases preservam nomes antigos durante migração;
- estados runtime são reconciliados: processos não sobrevivem ao app.

Mudança que remove, renomeia ou altera semântica de campo persistido exige teste
com JSON da versão anterior.

## Cotas

`usage.json` guarda por provider as janelas conhecidas e o instante da última
mudança. Cada janela tem tipo, percentual e reset. `scope` e `label` são
opcionais: snapshots antigos sem esses campos continuam sendo uma única cota;
snapshots novos usam `scope` para manter separadas cotas gerais e buckets de
modelo ou feature. O arquivo é cache: uma leitura válida do provider substitui
o conteúdo persistido.

## Transcripts

### Claude

O Claude Code grava em `~/.claude/projects/<slug-do-cwd>/<tab>.jsonl`. A pasta
deriva do caminho do worktree. O arquivo pode não existir até a primeira fala.

### Codex

O rollout nativo do Codex não é usado pela UI. O Prometheus grava os eventos V1
mostrados em `<root>/chats/<tab>.jsonl`; `Tab.agent_session` guarda a thread
opaca necessária para `thread/resume`.

### Compatibilidade

Leitura é tolerante a começo cortado e linhas inválidas isoladas. O buffer em
memória tem teto e corta somente em fronteira de linha. Eventos efêmeros de
streaming podem ser numerados sem serem persistidos quando a forma completa os
substitui.

`ConversationEventV1` mantém leitura do stream-json legado. Não há migração
destrutiva em lugar. Eventos persistentes do Codex também recebem uma projeção
legada `prometheusV1Mirror`: a versão atual a ignora, enquanto uma versão
anterior ignora o V1 e continua lendo o histórico após rollback.

## Segredos e logs

Prompts, outputs, tool results e credenciais podem conter segredo. Não envie
transcripts para telemetria e não imprima tokens/configurações completas em
logs. Erros podem registrar caminho e causa, mas nunca conteúdo ou credencial.
