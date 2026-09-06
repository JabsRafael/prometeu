# Ações e agentes reutilizáveis

Status: implementado; decisão no [ADR 0009](../decisions/0009-reusable-actions.md).

## Cadastro e entradas

`Board.actions` contém `profiles`, `commands`, `overrides`, `pr_action` e
`defaults_initialized`. Na primeira abertura, catálogos anteriores recebem o
perfil editável **Code review** e o comando `/review`. O perfil relata bugs e
riscos sem modificar arquivos ou publicar PR. A inicialização é registrada para
respeitar remoções e personalizações posteriores; nomes ou identidades existentes
não são sobrescritos. O JSON de origem está em
[`action-defaults.json`](../../src/action-defaults.json). O cadastro é local, reutilizável entre
projetos, e não é enviado ao relay.

- Um comando tem `name`, `description`, `kind: prompt | agent`, `prompt` e
  `profile` opcional. Nomes são únicos, com 1–64 letras ASCII minúsculas,
  números ou hífens; `compact` e `context` são reservados.
- `prompt` expande texto na caixa atual sem enviar. O texto restante acompanha
  a expansão e continua editável.
- `agent` inicia uma tarefa em outra aba. O pedido contém o texto do comando,
  título, repositórios/bases do workspace e contexto escrito pela pessoa.
- `/nome` e menu **Ações** usam o mesmo cadastro. Se o provider também expõe
  `/nome`, seu comando conserva o nome e o comando do app usa `/prometeu:nome`.
  O namespace explícito também funciona sem colisão.
  As sugestões de comandos cadastrados no app exibem a tag **Prometeu**;
  comandos e skills do provider não recebem essa tag.
- `pr_action: null` mantém o pedido de PR na conversa atual, incluindo a
  preferência pela skill do repositório. Um nome configurado aponta para um
  comando `agent` e serve ao botão **Open PR / Atualizar PR**.

## Perfil e execução

Um perfil tem identidade, nome, prompt, `choice` (provider/modelo/esforço),
MCP, plugins, nomes de skills, `permission: ask | auto` e `watch` opcional.
`overrides[project][profile]` substitui integralmente um perfil para aquele
projeto. Não altera o perfil global.

Cada `Tab.task` guarda uma cópia do perfil resolvido, nome do comando e estado
da execução. MCP/plugins `null` herdam a seleção do workspace no início;
listas vazias são seleções explícitas. Se o workspace também tem `null`,
permanece a configuração externa do provider. O catálogo não contém segredos:
credenciais continuam nos hubs existentes.

Alterar perfil ou seleção do workspace não muda essa cópia. A retomada usa o
mesmo perfil. Trocar modelo pelo rodapé de uma tarefa é recusado; edite o
perfil para execuções futuras. Plugins e MCP do Codex usam configuração
derivada por sessão de tarefa, para não trocar a seleção de outra conversa.

Skills são nomes instruídos ao agente, disponíveis na instalação ou nos
plugins selecionados. Essa lista não é uma allowlist nem desativa outras
skills do provider. Se uma skill não estiver disponível, a instrução é parar
e informar. O app não promete detecção automática desse resultado textual.

Permissões são materializadas pelo adapter: Claude usa seu modo normal de
aprovação em `ask`; Codex usa `approvalPolicy: untrusted`. `auto` mantém o
bypass existente. Essas opções não constituem isolamento do worktree.

Uma tarefa não monitorada termina quando termina seu turno. Acompanhamento é
opcional e não muda a etapa manual do workspace. Repetir o mesmo comando com
uma tarefa ainda aberta retorna a aba existente. Se houver contexto adicional,
o app recusa e preserva o rascunho para envio na aba da tarefa. Iniciar outra tarefa exige
que não haja conversa trabalhando, esperando resposta ou com fala pendente.

## Acompanhamento de PR

`watch` define intervalo em segundos (30–86400), comentários, resultados de CI
e limite de turnos automáticos (1–100). O exemplo de entrega usa 60 segundos e
10 turnos. As PRs são descobertas por branch e depois ficam presas ao número
por repositório. Repositórios sem PR não impedem conclusão das PRs encontradas.

Uma thread do backend consulta `gh`; não existe turno de modelo durante espera.
As consultas são sequenciais e têm prazo de 30 segundos por processo. O intervalo
é mínimo, não garantia de entrega em tempo real. Comentários gerais, reviews e
comentários em linhas usam paginação. Comentários da conta autenticada são
ignorados para evitar realimentação. Resultados de CI incluem sucesso, falha,
erro, timeout, cancelamento e pedido de ação; estados pendentes não acordam o
agente. O identificador inclui commit e execução do check quando disponível.

A execução guarda `seen` (hashes SHA-256 dos eventos), PRs, instante da consulta, contagem de turnos,
`paused`, `done` e último erro. Eventos repetidos não geram turno; edições de
comentários geram. Enquanto alguma conversa trabalha ou espera resposta,
novidades continuam sem confirmação e são agrupadas na consulta seguinte.
Cursor e fala pendente são gravados juntos antes do envio. Uma fala pendente
sobrevive ao reinício e pode ser retomada. Não há garantia de exactly-once na
janela entre o CLI aceitar a fala e a persistência do transcript.

Dados externos não concedem permissões: entram identificados como comentários
ou resultados de CI. Cada corpo de comentário é limitado a 12000 caracteres;
URL acompanha o texto para inspeção completa. Respostas de `gh` acima de 8 MiB
são recusadas. O limite de turnos pausa a execução; retomá-la renova o limite.

Fechar todas as PRs encontradas conclui o acompanhamento. Pausar, arquivar ou
limpar workspace suspende consultas; fechar aba remove a tarefa. Pausar não
interrompe um turno já em andamento. App fechado ou Mac suspenso não consulta;
a próxima abertura reconcilia novidades. Falhas de consulta ficam visíveis e
preservam cursores; falha/interrupção de turno pausa o acompanhamento.

## IPC e compatibilidade

- `actions_save({ catalog }) -> void`: valida referências, nomes e limites;
  persiste no board e publica evento `board`.
- `action_start({ workspace, name, context }) -> Tab`: resolve perfil, cria
  sessão local e inicia pedido. Erro de spawn permanece na aba para inspeção.
- `action_pause({ session, paused }) -> void`: pausa ou retoma acompanhamento.

Campos novos são aditivos com defaults na persistência. Sessões comuns não
mudam configuração de lançamento. Mock web implementa cadastro e criação de
abas, mas não consulta GitHub nem executa modelos. Evidências:
[`actions.test.ts`](../../src/actions.test.ts),
[`actions.rs`](../../src-tauri/src/actions.rs),
[`github.rs`](../../src-tauri/src/github.rs),
[`actions.spec.ts`](../../e2e/actions.spec.ts).
