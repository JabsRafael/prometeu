# ADR 0009 — comandos reutilizáveis e agentes responsáveis por tarefas

Data: 2026-09-05
Status: Aceito

## Contexto

O botão Open PR envia um pedido à conversa atual. É necessário reutilizar
prompts e agentes configuráveis sem vincular a tarefa a um botão específico.
Uma entrega pode revisar, abrir PR e reagir a comentários e CI na mesma sessão.

## Opções consideradas

1. Skills apenas: reutilizam instruções, mas não representam seleção de modelo,
   ferramentas, execução persistida e acompanhamento pelo software.
2. Um agente por fase e um editor genérico de workflows: exigem coordenação e
   handoffs antes de existir necessidade de revisão independente.
3. Comandos com dois comportamentos e perfis reutilizáveis: integram o chat,
   o menu e o botão de PR usando sessões existentes.

## Decisão

Adotar a terceira opção. Comandos expandem prompts ou iniciam agentes em outra
aba. Perfis possuem prompt, modelo/provider/esforço, MCP, plugins, skills,
permissões e acompanhamento opcional. Projetos podem substituir perfis.
Execuções guardam a configuração resolvida; a sessão continua sendo transcript.

Uma única sessão assume a responsabilidade pela entrega. Revisão, publicação
e correções são instruções do perfil; não são gates determinísticos de um
motor de workflows. Um resultado textual do agente não comprova aprovação de
revisão. O exemplo exige verificar o código publicado e não autoriza merge.

Acompanhamento usa polling no backend local por `gh`. O modelo só recebe turno
quando há novidades. Não há webhooks, mudança de responsabilidade do relay ou
execução em nuvem. Adaptadores continuam materializando diferenças de provider.

## Consequências

A pessoa pode começar com um prompt ou uma tarefa e reutilizá-los em projetos.
Não precisa criar três agentes para entregar uma PR. Um editor de workflows e
handoffs entre sessões permanecem evolução futura, sem estruturas especulativas.

Polling depende do app aberto, autenticação do `gh` e limites do GitHub. Cursor,
fala pendente, limite de turnos e pausa tornam o acompanhamento retomável e
observável. A seleção de skills é uma instrução, não isolamento de capabilities.

O contrato está em [ações](../contracts/actions.md). A persistência é aditiva;
boards antigos continuam com catálogo vazio e tarefas ausentes.

## Evidência

- [Comandos e expansão](../../src/actions.test.ts).
- [Persistência, validação e deduplicação](../../src-tauri/src/actions.rs).
- [Leituras do GitHub e filtragem](../../src-tauri/src/github.rs).
- [Cadastro, expansão e abertura em outra aba](../../e2e/actions.spec.ts).
