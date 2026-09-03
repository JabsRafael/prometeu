# ADR 0003 — Features dirigidas por capacidades

Data: 2026-09-03
Status: Aceito

## Contexto

Hoje, modelo identifica implicitamente provider e partes da UI comparam o nome
`codex` para esconder plan mode ou plugins. `agent` é uma string aberta tanto
no TypeScript quanto no estado Rust.

Esse desenho funciona com dois CLIs conhecidos, mas espalha conhecimento de
fornecedor. Um terceiro provider exigiria encontrar todas as condicionais e
decidir novamente quais combinações são válidas. Versões diferentes do mesmo
CLI também podem oferecer capacidades diferentes.

## Opções consideradas

1. Continuar adicionando condicionais por provider.
2. Criar uma interface diferente de UI para cada provider.
3. Descobrir providers em descriptors tipados e dirigir a UI por capacidades.

## Decisão

Introduzir `ProviderId` fechado, `AgentDescriptor`, `AgentModel` e
`AgentCapabilities`. O catálogo associa explicitamente modelo ao provider. UI
e validação usam capacidades do descriptor; apenas o registry/runtime faz
dispatch pelo `ProviderId`.

O contrato draft está em `docs/contracts/agent-runtime.md`.

## Implementação

- `ProviderId` é uma união fechada no TypeScript e um enum no Rust.
- O carregamento de board aceita `agent: ""` e normaliza a próxima gravação
  para `agent: "claude"`; valores desconhecidos também caem no default durante
  a migração.
- `src-tauri/src/agents.rs` produz `AgentDescriptor[]` com catálogo e
  capabilities; `src/agents.ts` é a fronteira consumida pela UI.
- Launcher, conversa e statusbar usam descriptors/capabilities. Dispatch
  nominal continua somente no catálogo e nos adapters.
- `scripts/check-architecture.mjs` falha se as telas principais voltarem a
  decidir por comparação direta com `claude` ou `codex`.
- Testes Rust cobrem normalização persistida e capabilities dos descriptors.

## Consequências

Positivas:

- suporte fica visível em uma estrutura única;
- UI deixa de conhecer nomes de providers;
- capacidades podem variar com CLI/modelo sem release de condicionais;
- providers novos falham por matching não exaustivo durante desenvolvimento;
- matriz de conformidade pode ser derivada do catálogo.

Negativas:

- catálogo e estado persistido precisam de migração;
- algumas capacidades não são puramente booleanas e podem exigir parâmetros;
- descriptor incorreto pode oferecer uma feature que falha em runtime;
- descoberta precisa de fallback explícito quando um CLI não responde.

## Critérios de aceitação atendidos

- condicionais atuais de plan mode, MCP, plugins e anexos foram migradas;
- capacidades atuais são publicadas por provider em runtime;
- migração de `agent: "" | "claude" | "codex"` possui teste de serialização;
- a fitness function impede novas decisões de UI baseadas no nome do provider;
- a matriz aponta evidência ou limitação para cada comportamento.
