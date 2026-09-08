# ADR 0029 — Remoção dos avisos sonoros

Data: 2026-09-08
Status: Aceito

Substitui o [ADR 0025](0025-completion-sound-per-execution.md) quanto ao som.

## Contexto

Mesmo após ajustes na detecção de conclusão, os avisos sonoros continuam
interrompendo a pessoa repetidamente. Foi solicitada a remoção da feature.

## Opções consideradas

1. Continuar ajustando a detecção ou desligar o som por padrão.
2. Remover o áudio e sua configuração, preservando os indicadores visuais.

## Decisão

Adotar a segunda opção. Remover a síntese do pling, a inicialização de
Web Audio por interação, os disparos de conclusão e comentários, a preferência
de som e sua linha nas Configurações. Remover também a memória de comentários
usada exclusivamente para evitar repetições do som.

O acompanhamento de execuções em `alert.ts` permanece para a bolinha do Dock,
incluindo perguntas, leitura, visibilidade, background e contagem de workspaces.
Os eventos dos adapters e do backend permanecem iguais.

## Consequências

O Prometeu deixa de oferecer avisos sonoros de conclusão e comentários.
A pessoa acompanha pendências pelos indicadores visuais existentes.

A chave legada `prometeu:som` fica inerte no localStorage. Não há migração,
reescrita de estado ou mudança nos formatos V1, IPC, transcript e relay;
por isso não se aplica teste de compatibilidade de formato.

## Evidência

- [Testes de pendências](../../src/alert.test.ts): contagem e leitura do Dock,
  perguntas, conclusões e comentários sem criar contexto de áudio.
- [Fluxos da interface](../../e2e/alerts.spec.ts): ausência de áudio na mesa,
  no workspace e com subagentes, além da remoção da opção nas Configurações.
