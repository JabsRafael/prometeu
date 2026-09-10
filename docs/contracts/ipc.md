# Contrato IPC TypeScript ↔ Rust

Status: current contract; TypeScript commands and browser handlers share typed
arguments and results. Rust bindings remain manually synchronized.

## Sources and guarantees

- `src/ipc.ts` owns `Commands`, with one argument/result pair for each command.
  `invoke` infers the result from the command and checks its arguments. Callers
  cannot supply an arbitrary result generic. `IpcArgs`, `IpcArguments`,
  `IpcResult`, `IpcCall`, and `IpcHandlers` support typed consumers and wrappers.
  Command unions must travel with their corresponding arguments as an `IpcCall`
  tuple; widening the command generic cannot bypass required arguments.
- `src/mock.ts` implements `IpcHandlers`. TypeScript checks every command's
  arguments and result. The browser's dynamic Tauri bridge performs one dispatch
  cast after checking that the command belongs to the handler map; plugin
  commands stay outside the application contract.
- `src-tauri/src/main.rs` registers Rust handlers in `generate_handler!`.
  `src-tauri/tests/mock.rs` checks exact name parity across this registration,
  the TypeScript map, and browser handlers.
- `src/ipc.test.ts` checks invocation forwarding and compile-time rejection of
  missing/invalid arguments, unknown commands, arbitrary result types, and
  incorrect mock results. `npm run typecheck` checks the entire frontend.

These checks do not generate Rust DTOs or validate runtime payloads. Rust
argument names, serde behavior, and serialized results must still match the
map and the existing boundary tests. Untrusted relay/control input remains
subject to backend validation. Errors keep their existing rejection format.
See [ADR 0024](../decisions/0024-typed-ipc.md).

## Regras de comando

- nomes usam `snake_case` e precisam ser únicos;
- argumentos TypeScript usam as chaves esperadas pela desserialização Tauri;
- retorno Rust deve implementar `Serialize`;
- argumento Rust deve implementar `Deserialize`;
- operação falível retorna `Result<Resposta, Erro>`;
- erro de domínio usa código estável traduzido pelo frontend;
- detalhe externo ou de I/O pode acompanhar o código sem virar texto fixo da UI;
- operação pesada não bloqueia a thread principal.

Os comandos de status, diffs, branches, commits e resolução de conflitos estão
em [`git.md`](git.md). Eles são aditivos: `workspace_diff` mantém o contrato
anterior e não passa a significar stage.

Os comandos `actions_save`, `action_start` e `action_pause` estão descritos no
[contrato de ações](actions.md). Usam o evento `board` existente.

## Estado privado de E2EE

- `team_security`: sem argumentos, retorna o envelope de segurança ou `null`
  somente quando o arquivo não existe. Leitura inválida retorna erro.
- `team_security_set`: recebe `{ state }`, valida versão e limite de 8 MiB e
  grava atomicamente o arquivo privado; retorna vazio ou erro. Um arquivo
  existente ilegível não é sobrescrito.

Os comandos existem no Rust, no registro tipado e no mock. A webview precisa
da identidade privada para WebCrypto; ela não atravessa o WebSocket. O schema
interno dos escopos pertence a `team-security.ts`; os payloads permanecem `unknown`
no mapa IPC até essa validação em runtime; veja [persistência](persistence.md).

## Eventos emitidos atualmente

Os comandos `cloud_status`, `cloud_login_start`, `cloud_login_poll`,
`cloud_login_cancel` e `cloud_logout` estão no [contrato da conta](cloud-account.md);
`catalog_state` e `catalog_refresh`, no [contrato do catálogo](cloud-catalog.md).
Não retornam Bearer nem senha para a webview. `cloud_organizations`,
`cloud_relay_ticket` e os argumentos `remoteControl` e `team` de `set_shared` estão no
[contrato de organizações](cloud-organizations.md); somente o ticket curto
atravessa IPC para autenticar o WebSocket.

| Evento | Emissor | Payload emitido |
| --- | --- | --- |
| `board` | `state.rs` | `Board` completo |
| `chat` | `chat.rs` | `[session, conversationEventV1JsonLine, seq]` |
| `chat-closed` | `chat.rs` | id da sessão |
| `pty` | `pty.rs` | `[session, bytes, seq]` |
| `pty-closed` | `pty.rs` | `[session, exitCode]` |
| `usage` | `usage.rs` | snapshot de uso por ID local de conta |
| `accounts` | `accounts.rs` | cadastro, seleção por provider e login pendente |
| `account-error` | `chat.rs` | erro traduzível de uma troca ao enviar a fala pendente |
| `machine` | `machine.rs` | estado da máquina |
| `linear` | `linear.rs` | `LinearStatus` |
| `plugin-make` | `plugins.rs` | `[run, step]` |
| `plugin-made` | `plugins.rs` | `[run, error]` |
| `browser:url` | `browser.rs` | `[workspace, url]` |
| `file-drag` | `file_drop.rs`, webview principal | `{ type, paths, position?, id?, error? }` |

`file-drag` adapta o arraste nativo sem alterar os eventos internos do Tauri.
O registro usa `on_webview_event`, filtrando a webview `main`: com a feature
`unstable`, o runtime cria até a webview principal como filha da janela e
não entrega seu arraste aos listeners de `WindowEvent`.
`enter`, `over`, `leave` e `drop` representam o gesto; `paths` é sempre uma
lista. `position` contém `{ x, y }` nas coordenadas do runtime: no macOS/wry
0.55 são pontos lógicos da janela, sem divisão por DPR.

Para uma promessa do macOS, `pending` substitui `drop`, com `id` único e a
posição final. O frontend captura o rascunho de destino nesse instante.
O rascunho conta recebimentos pendentes e bloqueia o envio em todas as suas
apresentações; conclusão ou erro libera o envio quando a contagem chega a zero.
`received` conclui o mesmo `id` com os caminhos locais materializados e
`error` opcional; pode trazer arquivos válidos mesmo quando outro falha.
Recebimentos desconhecidos ou duplicados são ignorados. A espera nativa tem
limite de 30 segundos, sem bloquear a UI. `src/mock.ts` simula as mesmas fases.

O contrato é aditivo, interno ao bundle app/frontend. Não há mudança em
`chat_send`, no V1 ou no relay: o agente continua recebendo menções de caminhos.
Veja [ADR 0018](../decisions/0018-native-file-promises.md).

Os comandos `accounts`, `account_select`, `account_remove`, `account_login` e
`account_login_cancel` estão definidos em [`accounts.md`](accounts.md).

O snapshot do evento e comando `usage` é um mapa por ID local de conta. As
chaves antigas `claude` e `codex` representam as contas dos CLIs originais;
contas adicionais usam UUIDs, sem alterar o formato dos valores. Cada entrada
tem `{ windows, at }`; cada janela tem `{ kind, pct, resets, scope?, label? }`.
`scope` identifica cotas independentes para que atualizações esparsas de um
modelo não apaguem as demais, e `label` é texto externo opcional para exibição.
Consumidores devem aceitar os dois campos ausentes por compatibilidade com o
cache anterior.

Eventos Tauri são dinâmicos; o generic passado a `listen<T>` não valida o
payload Rust em build time. Um evento novo precisa de teste do emissor e do
consumidor.

`chat_snapshot.text` pode misturar linhas V1 e legado depois de uma importação.
`Timeline` valida V1 e envia o restante ao leitor legado; projeções históricas
`prometheusV1Mirror` são ignoradas pelo leitor atual. O Prometeu não produz
essas projeções em logs novos.

## Raiz dos comandos de arquivo

`list_dir`, `read_file`, `read_bytes`, `write_file`, `find_paths` e `reveal`
recebem em `id` o workspace **ou** o projeto. Workspace resolve no worktree;
projeto resolve na pasta do clone registrado, que é o que sustenta ler e editar
um repositório sem workspace nenhum nele. Os dois espaços de id não colidem, e
`session.rs::cwd_of` é a única função que faz essa resolução — `dock.rs` a
importa em vez de repetir a regra. Caminho fora da raiz continua recusado.

`open_dock` aceita id de projeto apenas para terminal: o shell só precisa da
pasta, e sem workspace não há variável de script para passar. Setup e Run
continuam exigindo workspace e respondem `err.session.noWorkspace`.
`workspace_scripts` e `dock_state` já toleravam id sem workspace — devolvem
catálogo vazio e nenhuma porta.

## Importação legada

`legacy_import_plan` não altera estado. Ele devolve a origem, uma das situações
`ready | missing | imported | targetNotEmpty | invalid`, as contagens da prévia
e, quando aplicável, erro, instante e caminho do backup.

`legacy_import_run` não recebe caminhos da apresentação: origem e destino são
resolvidos pelo backend. Ele repete todas as validações, recusa o Prometheus
aberto e um destino ocupado, executa a importação e devolve o mesmo DTO no
estado `imported`. A mudança do board continua sendo publicada pelo evento
`board`.

## Checklist de mudança

Ao criar ou mudar comando:

1. alterar a função Rust e seu tipo de erro;
2. registrar o handler em `main.rs`;
3. update the command name, argument shape, and result in `src/ipc.ts`;
4. implementar ou recusar conscientemente no `src/mock.ts`;
5. atualizar todos os consumidores TypeScript;
6. adicionar teste da forma dos argumentos e retorno;
7. documentar compatibilidade quando houver estado persistido envolvido.

Ao criar ou mudar evento:

1. definir payload e ownership;
2. testar serialização no emissor;
3. validar o payload no consumidor quando vier de fronteira não confiável;
4. garantir que listeners sejam desmontados junto do lifecycle da tela;
5. atualizar a tabela acima.

## Direção de evolução

The implemented map requires no new dependency:

```ts
type Commands = {
  load_board: { args: undefined; result: Board };
  chat_send: { args: { session: string; text: string }; result: void };
};
```

A future step may generate bindings from Rust DTOs. A ferramenta deve
ser escolhida em ADR depois de uma prova pequena com:

- enums com `serde(rename_all)`;
- `Option` e campos default;
- erros serializados;
- eventos, além de commands;
- integração com Tauri 2 e a versão de Rust usada no projeto.

Gerar tipos de structs internas inteiras não é o objetivo. Apenas DTOs da
fronteira devem aparecer no binding.

## Feedback

`feedback_capture` é aditivo, sem argumentos, e retorna PNG base64 ou `null`.
Veja [captura e limites](feedback.md). O mock retorna imagem fictícia.

`feedback_send` recebe `{ report }` e não retorna valor. O backend entrega ao
Cloud com a credencial da conta, que nunca entra na webview, e devolve erro com
código i18n: `feedback.needAccount` sem conta ou 401, `feedback.rateLimit` no
limite, `feedback.uncertain` com `{id}` em entrega incerta e `feedback.sendError`
no resto. O mock registra o relato e nada sai da máquina.
