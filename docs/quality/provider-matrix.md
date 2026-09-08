# Matriz de providers

Status: comportamento atual observado no código. “A confirmar” significa que a
feature pode existir, mas ainda não possui evidência de conformidade suficiente
para virar capacidade contratual.

## Legenda

- **Nativo:** o CLI já fala a forma consumida hoje.
- **Adaptado:** o Prometeu converte ou implementa a feature.
- **Indisponível:** a UI não oferece porque o provider não suporta o fluxo.
- **A confirmar:** falta fixture ou teste dedicado.

| Capacidade | Claude | Codex | Evidência principal |
| --- | --- | --- | --- |
| organizações, convites e compartilhamento institucional | mesmo relay V3; execução local | mesmo relay V3; execução local | `team-organizations.test.ts`, `worker.integration.test.ts`, `e2e/organizations.spec.ts`, integração/browser Rails |
| conta opcional do Prometeu na barra lateral | independente do CLI | independente do CLI | `cloud.rs`, `e2e/cloud.spec.ts`; nenhum transcript é enviado |
| catálogo de plugins, MCP e Ações na conta | independente do CLI | independente do CLI | `catalog.rs`, `catalog_test.rb`; segredos e instalação ficam por Mac |
| formulário de Ações com componentes compartilhados | mesma UI | mesma UI; opções vêm do catálogo | `e2e/ui.spec.ts`, `e2e/actions.spec.ts`, Chromium e WebKit |
| componentes executáveis do DS da empresa | independente do provider | independente do provider | `e2e/design-system.spec.ts`, menu, submenu, senha, foco, validação e erro nos dois motores |
| Code review incluído e editável | perfil inicial; pode trocar modelo/provider | pode ser escolhido no perfil | `actions.rs`, `actions.test.ts`, `e2e/actions.spec.ts` |
| comandos de prompt e tarefas | adaptado pelo app | adaptado pelo app | `actions.test.ts`, `e2e/actions.spec.ts` |
| perfil por tarefa | instruções e permissões por flags | instruções e permissões por JSON-RPC | testes de `session.rs` e `codex.rs` |
| acompanhamento de PR | polling local pelo app | polling local pelo app | `actions.rs`, `github.rs`; sem integração GitHub real em testes |
| detectar instalação | adaptado | adaptado | `agents.rs` |
| contas e seleção global no rodapé | adaptado por `CLAUDE_CONFIG_DIR` | adaptado por `CODEX_HOME` | `accounts.rs`, `e2e/accounts.spec.ts` |
| remover todas as contas e seleção vazia | suportado; preserva login do CLI | suportado; preserva login do CLI | `accounts.rs`, `e2e/accounts.spec.ts`; diretórios e credenciais permanecem locais |
| login pelo app | CLI `auth login` e navegador | app-server `account/login/start` e navegador | fixtures de identidade em `claude.rs` e `codex/account.rs`; OAuth com duas contas reais ainda exige validação manual |
| troca de conta entre turnos | retomada do transcript compartilhado | retomada de rollout/índice compartilhados | `chat.rs`, testes de perfis; continuação autenticada entre duas contas reais ainda não comprovada pela suíte |
| cotas por conta | stream e endpoint interno | app-server e fallback interno | `usage.rs`, `e2e/accounts.spec.ts` |
| catálogo vivo de modelos | nativo via control request | nativo via cache do CLI | `agents.rs` |
| iniciar sessão | nativo | adaptado para JSON-RPC | `chat.rs`, `codex.rs` |
| retomar sessão | id/transcript do Claude | thread do app-server | `session.rs`, testes Rust |
| escolher modelo | nativo por flag | adaptado no `thread/start`/`thread/resume` | `session.rs`, `codex.rs` |
| níveis de esforço | catálogo + fallback | catálogo do Codex | `agents.rs`, `launcher.ts` |
| plan mode inicial | nativo por permission mode | indisponível | `session.rs`, `launcher.ts` |
| texto em streaming | adaptado para V1 | adaptado para V1 | `conversation.test.ts`, `timeline.test.ts`, testes de `codex.rs` |
| pensamento | adaptado para V1 | adaptado para V1 | `timeline.test.ts`, testes de `codex.rs` |
| tool call e resultado | adaptado para V1 | adaptado para V1 | `conversation.test.ts`, testes de `claude.rs`/`codex.rs` |
| perguntas ao usuário | nativo | adaptado de request JSON-RPC | `chat.ts`, testes de `codex.rs` |
| pedidos de aprovação | nativo | adaptado | `chat.rs`, `codex.rs` |
| interrupção | control request | `turn/interrupt` | `codex.rs`, testes Rust |
| compactação | comando do CLI | `thread/compact/start` | testes de `codex.rs` |
| relatório de contexto | stream/transcript | sintetizado de token usage | `context.test.ts`, testes de `codex.rs` |
| seleção de MCP por workspace | config estrita do CLI | tabela e ambiente montados pelo app | `mcp.rs`, `codex.rs`; erro de preparação impede spawn |
| seleção de plugins por workspace | flags de sessão | marketplace + config isolada por workspace | `plugins.rs`, smoke do CLI, `codex.rs`, `launcher.ts`, E2E |
| skills locais e da conta | pacote com SKILL.md via seleção de plugins | mesmo pacote com manifesto nativo | `skills.rs`, `catalog.rs`, `e2e/cloud.spec.ts`; instalação não ativa automaticamente |
| hooks de plugin escolhido | ativos desde `SessionStart` | `enabled = true` + confiança limitada a `pluginId` e hash antes da thread | testes de `codex.rs`; falha impede a thread |
| anexos na fala e miniaturas de captura | adaptado por caminho local; promessa materializada pelo macOS | adaptado por caminho local; promessa materializada pelo macOS | `file_drop.rs`, `chat.ts`; `e2e/file-drop.spec.ts` e cenários de arquivo solto em `e2e/critical-flows.spec.ts` cobrem UI sobre mock |
| evento externo desconhecido | ignorado pelo adapter | ignorado pelo adapter | `conversation.test.ts`, testes de `claude.rs`/`codex.rs` |
| subagentes do CLI | sidechain fora da tela | threads de outro `threadId` ignoradas; o turno da conversa segue | `claude.rs`, teste `turno_de_subagente_nao_encerra_a_conversa` em `codex.rs` |
| som de conclusão ou pergunta | eventos V1 locais ao vivo | eventos V1 locais ao vivo | `src/alert.test.ts`, `e2e/alerts.spec.ts`; status e replay não avisam, pendência não repete sem interação |
| compartilhamento ao vivo | V1 após normalização | V1 após normalização | `team*.test.ts`, E2E sobre mock |
| comentários em sessão compartilhada | adaptado após V1 | adaptado após V1 | `notes.test.ts`, `team.test.ts`, `relay/src/logic.test.ts`, E2E sobre mock |
| mesa com várias conversas ao mesmo tempo | adaptado (mesma tela da conversa) | adaptado (mesma tela da conversa) | `desk.test.ts`, E2E sobre mock |
| Git: revisão unificada/lado a lado, stage, commit, remotos, branches e conflitos | adaptado pelo app; independente do CLI | adaptado pelo app; independente do CLI | `session/git_tests.rs`, `diff.test.ts`, `e2e/git.spec.ts` em Chromium/WebKit e revisão grande em `e2e/critical-flows.spec.ts`; contrato `git.md` |
| agentes por workspace na barra lateral | marca e status de cada aba | marca e status de cada aba | fluxos da barra lateral em `e2e/critical-flows.spec.ts`; remoto usa avatar do dono, sem inferir provider |

## Regra para feature nova

Antes de habilitar uma feature para um provider:

1. declarar sua semântica comum no contrato;
2. adicionar ou ajustar a capacidade no descriptor;
3. capturar fixture real do CLI sem segredo ou dado pessoal;
4. provar tradução para eventos comuns;
5. executar o mesmo cenário no reducer e no mock;
6. atualizar esta matriz com o caminho da evidência.

Ausência de teste não deve virar `true` por semelhança entre providers.

## Limitações conhecidas

- origem de plugin em `.zip` local ou URL funciona no Claude e é recusada com
  erro visível no Codex; pasta local é o formato portátil;
- skills, comandos, MCP e hooks possuem adaptação portátil; `agents/*.md`
  permanece exclusivo do Claude porque não integra o manifesto Codex atual;
- plugins habilitados fora do Prometeu continuam sujeitos ao cadastro global
  de cada CLI e não fazem parte da seleção do workspace;
- anexos possuem testes de UI sobre mock e validação nativa do destino salvo;
  o gesto real da miniatura foi confirmado no Prometeu Dev em 2026-09-06.
  A leitura efetiva pelo CLI ainda exige verificação manual. Promessas que
  falham ou excedem 30 segundos produzem erro visível.

## Suíte de conformidade desejada

| Cenário | Fixture externa | Adapter | Reducer | E2E |
| --- | --- | --- | --- | --- |
| fala simples | por provider | obrigatório | obrigatório | smoke |
| streaming + mensagem final | por provider | obrigatório | obrigatório | crítico |
| ferramenta bem-sucedida | por provider | obrigatório | obrigatório | crítico |
| ferramenta com erro | por provider | obrigatório | obrigatório | crítico |
| pergunta e resposta | por provider | obrigatório | obrigatório | crítico |
| interrupção | por provider | obrigatório | obrigatório | smoke |
| resume | por provider | obrigatório | replay | crítico |
| compactação | por provider capaz | obrigatório | obrigatório | smoke |
| background task | por provider capaz | obrigatório | obrigatório | smoke |
| evento desconhecido | sintética | obrigatório | obrigatório | não necessário |

E2E não substitui contrato: ele cobre poucos caminhos caros. Fixtures e
reducers dão diagnóstico rápido para todas as combinações.
