# ADR 0011 — Primitivas compartilhadas de interface

Status: localização dos tokens e do CSS compartilhado substituída pelo
[ADR 0016](0016-company-design-system.md). Contratos de interação preservados.

## Contexto

Os editores de Ações duplicavam campos e usavam seletores nativos diferentes
do launcher. Regras de CSS de inputs de texto atingiam checkboxes. Corrigir
cada tela isoladamente mantinha as divergências de aparência e interação.

## Decisão

Consolidar os tokens existentes e primitivas DOM em `ui-tokens.css`, `ui.css`
e `ui.ts`. Extrair o dropdown existente do launcher, mantendo `menu.ts` e
`icons.ts` compartilhados. Ações passa a usar a base; campos dos hubs MCP e
plugins também. Uma galeria executável e testes nos dois motores documentam
os estados e comportamentos.

Novos formulários usam `dialog.showModal()` para modalidade e foco nativos,
com ciclo de Tab explícito para consistência entre motores. Menus de diálogos
são inseridos na mesma camada. Componentes recebem texto traduzido e callbacks;
não conhecem IPC ou regras de agentes.

## Consequências

Sem framework ou dependência adicional. Alterações nas primitivas exigem
verificação das telas consumidoras. A migração é incremental: estilos de
composição e modais antigos permanecem até uma mudança exigir sua adoção.
Tokens antigos conservam valores, e a mudança não altera persistência ou IPC;
testes de compatibilidade de dados não se aplicam.

## Evidência

- [Guia e galeria](../architecture/design-system.md).
- [Testes das primitivas](../../e2e/ui.spec.ts).
- [Testes de Ações](../../e2e/actions.spec.ts).
