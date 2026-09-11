# Conversation Events v1

Status: contrato vigente desde 2026-09-03.

Claude e Codex possuem protocolos externos diferentes. Os adapters traduzem
ambos para eventos e comandos pertencentes ao Prometeu antes de buffer, IPC,
persistência nova ou colaboração. As fontes executáveis do contrato são
`src/conversation.ts` e `src-tauri/src/conversation.rs`.

## Envelope e transporte

Cada evento é um objeto JSON em uma linha:

```ts
type EventBase<T extends string> = {
  v: 1;
  type: T;
  at: number; // Unix time in milliseconds
};
```

Sessão e sequência não ficam no evento. IPC e relay carregam a linha no
envelope de transporte existente: `[session, line, seq]`. A sequência junta
snapshot e live stream, mas não é identidade durável.

Campos desconhecidos são ignorados. Versão, tipo ou campo obrigatório inválido
descarta apenas a linha. Tipo desconhecido é no-op e não encerra a sessão.

## Conteúdo comum

```ts
type InputContent =
  | { kind: "text"; text: string }
  | { kind: "image"; name: string; mediaType: string }
  | { kind: "file"; name: string };

type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown };

type BackgroundTask = {
  id: string;
  description: string;
  toolId: string | null;
};
```

O contrato atual envia anexos ao provider como menções de caminho dentro do
texto. Metadados de imagem e arquivo estão reservados para uma implementação
que transporte anexos separadamente; bytes e caminhos locais não entram no
transcript compartilhado por inferência.

Contextos de elementos do browser usam uma convenção textual aditiva dentro
de `text`, sem novo tipo de evento ou comando. A apresentação transforma apenas
blocos válidos em tags; reducer, adapters e transcript preservam a string
completa. Veja o [contrato do browser](browser.md#contexto-no-texto-da-mensagem).

## Eventos persistentes

```ts
type ConversationEventV1 =
  | (EventBase<"user.message"> & { content: InputContent[] })
  | (EventBase<"assistant.block"> & {
      messageId: string;
      index: number;
      block: AssistantBlock;
    })
  | (EventBase<"tool.completed"> & {
      toolId: string;
      output: string;
      error: boolean;
      background: boolean;
    })
  | (EventBase<"request.opened"> & {
      requestId: string;
      kind: "approval" | "question" | "plan";
      toolId: string | null;
      tool: string | null;
      input: Record<string, unknown>;
    })
  | (EventBase<"request.closed"> & {
      requestId: string;
      outcome: "allowed" | "denied" | "answered" | "cancelled";
    })
  | (EventBase<"turn.completed"> & {
      outcome: "ok" | "error" | "interrupted";
      message: string;
      durationMs: number | null;
      costUsd: number | null;
    })
  | (EventBase<"context.compacted"> & {
      before: number | null;
      after: number | null;
    })
  | (EventBase<"background.changed"> & { tasks: BackgroundTask[] })
  | (EventBase<"system.notice"> & {
      level: "info" | "warning" | "error";
      code: string;
      detail: string;
    })
  | (EventBase<"system.summary"> & { text: string })
  | (EventBase<"context.reported"> & { markdown: string });
```

`assistant.block` é autoritativo por `(messageId, index)`. Blocos do mesmo
`messageId` formam uma mensagem visual. Resultado para ferramenta ou fechamento
de pedido desconhecido é no-op; nunca derruba o replay.

`turn.completed` encerra o turno e qualquer compactação visual, mas não encerra
tarefas em background. Custo fica no evento comum como número opcional: Claude
pode preenchê-lo e Codex pode usar `null` sem introduzir uma extensão de
provider no histórico.

## Eventos efêmeros

Não são gravados no transcript:

```ts
type ConversationEphemeralV1 =
  | (EventBase<"assistant.started"> & { messageId: string })
  | (EventBase<"assistant.block.started"> & {
      messageId: string;
      index: number;
      block: AssistantBlock;
    })
  | (EventBase<"assistant.delta"> & {
      messageId: string;
      index: number;
      kind: "text" | "thinking";
      delta: string;
    })
  | (EventBase<"tool.input.delta"> & {
      messageId: string;
      index: number;
      toolId: string;
      delta: string;
    })
  | (EventBase<"context.compaction"> & {
      state: "started" | "stopped" | "failed";
      detail: string;
    })
  | (EventBase<"context.updated"> & { used: number; window: number | null })
  | (EventBase<"session.state"> & {
      state: "starting" | "ready" | "busy" | "waiting" | "stopped";
    })
  | (EventBase<"session.identity"> & { providerSession: string })
  | (EventBase<"commands.updated"> & {
      commands: Array<{ name: string; description: string; hint: string }>;
    })
  | (EventBase<"usage.updated"> & {
      provider: "claude" | "codex";
      usage: unknown;
    });
```

Deltas antecipam a apresentação; `assistant.block` substitui o rascunho do
mesmo índice. Eventos efêmeros ainda recebem sequência de transporte para que
snapshot e live stream mantenham a mesma ordem.

No stream local ao vivo, `chat.rs` emite `session.state` com `starting` ao
iniciar um processo e com `busy` depois que a escrita de `message.send` é
aceita. Esse `busy` precede `user.message`, ecos locais e respostas concorrentes,
sob o mesmo lock de publicação; uma escrita que falha não o emite. Respostas
a pedidos e ecos do provider não representam outra aceitação de mensagem.
O snapshot pode sintetizar `busy` ou `ready` para apresentar o estado atual,
mas não inicia uma nova execução no acompanhamento de pendências do Dock.
Esses eventos continuam efêmeros, sem mudança de envelope, formato persistido
ou versão do contrato.
Não há avisos sonoros; veja [ADR 0029](../decisions/0029-remove-alert-sound.md).

`usage.updated` identifica o provider porque cota é uma informação da conta e
os payloads externos não possuem semântica comum suficiente. Esse payload vai
direto ao adapter de uso, não à timeline nem ao transcript.

## Comandos

```ts
type ConversationCommandV1 =
  | { v: 1; type: "message.send"; text: string }
  | {
      v: 1;
      type: "request.respond";
      requestId: string;
      response:
        | { outcome: "allow" }
        | { outcome: "deny"; message: string }
        | { outcome: "answer"; answers: Record<string, string> };
    }
  | { v: 1; type: "turn.interrupt" }
  | { v: 1; type: "permission.mode.set"; mode: "bypass" }
  | { v: 1; type: "commands.list" };
```

Slash commands continuam sendo texto de `message.send`: a interpretação
pertence ao adapter, pois disponibilidade e implementação variam. A lista para
autocomplete usa `commands.list` e `commands.updated`.

Modelo, esforço, MCP e plugins configuram a sessão fora deste contrato.
`permission.mode.set` só é oferecido quando a capability do provider permite.

## Segurança

- controle remoto é validado no Mac que possui o processo;
- `request.respond` remoto só vale para pedido aberto no buffer;
- input de aprovação é reconstruído do pedido original, nunca aceito do cliente;
- respostas de pergunta aceitam apenas chaves existentes no pedido;
- modo irrestrito não pode ser ativado remotamente;
- eventos não concedem acesso a filesystem por si mesmos.

## Persistência e legado

Transcripts anteriores não são reescritos. `LegacyConversationAdapter` traduz
linhas antigas durante o replay, fora do reducer. O transcript do Claude
continua pertencendo ao CLI; eventos ao vivo já chegam normalizados.

O Prometeu grava apenas o evento V1 no log administrado para Codex. O leitor
continua ignorando projeções marcadas com `prometheusV1Mirror` e traduzindo o
discriminante legado `type: "prometheus"`; esses nomes pertencem ao formato
histórico do produto anterior e não são emitidos em logs novos. A mudança da
política de rollback está registrada no ADR 0004.

## Evidência

- `src/conversation.test.ts`: parser, replay V1 e equivalência com legado;
- `src/timeline.test.ts`: streaming, ferramentas, requests, background e compactação;
- testes de `claude.rs`: tradução stream-json, comandos e desconhecidos;
- testes de `conversation.rs`: envelope V1;
- testes de `codex.rs`: comandos V1, protocolo JSON-RPC e saída V1 direta;
- testes de `chat.rs`: persistência, sequência e reconstrução segura de controle remoto.
