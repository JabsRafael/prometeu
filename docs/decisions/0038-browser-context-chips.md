# ADR 0038 — elementos selecionados como tags na conversa

Data: 2026-09-10
Status: Aceito

## Contexto

O browser do ADR 0037 acrescentava HTML, CSS e geometria diretamente ao texto
editável. Esse JSON ocupava o composer e o histórico, dificultando escrever
o pedido. O contexto precisa continuar completo para o agente e no replay.

## Opções consideradas

- Introduzir um tipo de conteúdo no protocolo de conversa: exige alterar
  adapters, fila, persistência e colaboração para uma mudança de apresentação.
- Esconder dados somente em memória: perde a apresentação após replay e impede
  colegas de reconhecer o contexto recebido pelo agente.
- Manter tags no rascunho e usar um bloco textual identificado no envio:
  preserva os transportes existentes e permite apresentação compacta no replay.

## Decisão

Manter elementos e suas capturas no rascunho por conversa, separados do texto.
Exibir tags removíveis, com detalhes acessíveis por botão. No envio, serializar
cada elemento no formato textual versionado definido no
[contrato do browser](../contracts/browser.md#contexto-no-texto-da-mensagem).

Somente a apresentação reconhece esses blocos. O reducer, os adapters e o
relay não os removem nem os reinterpretam. Leitura estrita limita estrutura,
tamanho e tipos; blocos inválidos permanecem literais. Conteúdo da página é
sempre exibido como texto, sem executar HTML ou ler caminhos locais do histórico.

## Consequências

Desktop, mesa e celular exibem tags para mensagens novas sem ampliar V1 ou IPC.
Clientes anteriores continuam mostrando o bloco completo. Transcripts antigos
não são reescritos. Remover uma tag retira também a captura associada do envio;
capturas avulsas continuam sendo anexos comuns.

## Evidência

- `src/browser-context.test.ts`: roundtrip e fallback de conteúdo inválido.
- `e2e/browser.spec.ts`: rascunho, remoção, conteúdo enviado, replay e fila persistida.
- `e2e/mobile.spec.ts`: tags e detalhes no histórico compartilhado.
