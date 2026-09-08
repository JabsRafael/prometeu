# ADR 0025 — Som de conclusão por execução aceita

Data: 2026-09-08
Status: Aceito

## Contexto

O aviso sonoro compartilhava a pendência de leitura da aba. Olhar a conversa
ou responder a um pedido rearmava essa pendência; um resultado intermediário
ou uma continuação automática podia tocar novamente enquanto o agente ainda
trabalhava. Perguntas também usavam o som de conclusão. No Codex, o isolamento
de threads filhas descartava a informação necessária para acompanhar subagentes.

## Opções consideradas

1. Ajustar a pendência de leitura ou inferir conclusão pelo status do quadro.
   Ambos misturam atenção da pessoa com execução e snapshots defasados.
2. Inferir conclusão por um intervalo sem saída. Uma ferramenta demorada pode
   ficar silenciosa enquanto continua trabalhando.
3. Acompanhar a execução aceita com eventos V1 ao vivo e exigir um terminal
   principal, sem tarefas em background, antes de avisar.

## Decisão

Adotar a terceira opção. `chat.rs` emite o evento efêmero existente
`session.state` com `starting` ao iniciar o processo e `busy` após aceitar
`message.send`. A publicação de `busy`, da fala e dos ecos fica sob o mesmo
lock, antes de respostas concorrentes. Escrita malsucedida não arma um aviso.

`alert.ts` mantém o estado da execução por aba separado da pendência de leitura.
Só `busy` local ao vivo arma o aviso; atividade do assistente confirma execução.
Um `turn.completed` com sucesso ou erro e sem tarefas em background agenda o
aviso para 1 segundo depois. Nova atividade cancela o candidato. Silêncio sem
terminal não agenda aviso. Interrupção e terminal sem atividade consomem a
execução sem som; erro pode avisar mesmo sem atividade anterior.

Uma conclusão visível ou com som desligado também consome a execução. Olhar,
responder a pedidos, ecos e eventos sintetizados no snapshot não a rearmam.
Perguntas e permissões mantêm a indicação do Dock, sem som de conclusão.

Os adapters mantêm a responsabilidade sobre subagentes. Claude já emite
`background.changed`. Codex normaliza `collabAgentToolCall.agentsStates`,
`subAgentActivity` e eventos de filhos conhecidos, sem inserir o conteúdo dos
filhos na conversa principal. O fim de uma tarefa em background não toca:
é necessário receber outro terminal do agente principal.

## Consequências

O aviso deixa de depender da navegação e da marcação de leitura. A regra comum
cobre Claude e Codex sem payloads externos na apresentação. Formatos V1, IPC,
transcripts e relay não mudam; não há migração de dados nem novos comandos.

A janela de 1 segundo absorve continuações imediatas e acrescenta essa latência
ao aviso. A detecção depende dos sinais emitidos pelo CLI: não há garantia
contra uma continuação posterior não anunciada. Uma tarefa em background que
termina sem nova resposta final do agente principal não produz som.

## Evidência

- [Regressões de estado e som](../../src/alert.test.ts): eventos intermediários,
  subagentes, leitura, respostas, interrupções, visibilidade e som desligado.
- [Fluxos de mesa e workspace](../../e2e/alerts.spec.ts): Chromium e WebKit.
- Testes de [chat.rs](../../src-tauri/src/chat.rs): `busy`, fala e eco precedem
  respostas concorrentes; falha de escrita não publica `busy` nem fala.
- Testes de [codex.rs](../../src-tauri/src/codex.rs): isolamento de filhos,
  spawn, atividade e estados parciais de subagentes.
- [Contrato V1](../contracts/conversation-events-v1.md) e
  [matriz de providers](../quality/provider-matrix.md).
