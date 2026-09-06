# Registro de decisões arquiteturais

Cada ADR registra uma decisão significativa, seu contexto e suas consequências.
Use um arquivo novo para mudar uma decisão aceita; não reescreva o passado.

## Estados

- **Proposto:** em discussão; não é regra vigente.
- **Aceito:** orientação atual do projeto.
- **Substituído:** outro ADR tomou seu lugar; mantenha link nos dois sentidos.
- **Rejeitado:** considerado e não adotado.

## Template

```md
# ADR NNNN — título

Data: AAAA-MM-DD
Status: Proposto

## Contexto

## Opções consideradas

## Decisão

## Consequências

## Evidência
```

## Índice

| ADR | Estado | Assunto |
| --- | --- | --- |
| [0001](0001-repository-knowledge.md) | Aceito | conhecimento do repositório como fonte de verdade |
| [0002](0002-canonical-conversation-protocol.md) | Aceito; espelho substituído | protocolo canônico de conversa |
| [0003](0003-agent-capabilities.md) | Aceito | features dirigidas por capacidades |
| [0004](0004-prometeu-independent-identity.md) | Aceito | identidade independente do Prometeu |
| [0005](0005-portable-plugin-marketplace.md) | Aceito | marketplace portátil para Claude e Codex |
| [0006](0006-explicit-prometheus-import.md) | Aceito | importação explícita e não destrutiva do Prometheus |
| [0007](0007-persistent-session-comments.md) | Aceito | comentários persistentes ao lado da sessão |
| [0008](0008-explicit-git-index.md) | Aceito | índice Git explícito e operações por repositório |

| [0009](0009-reusable-actions.md) | Aceito | comandos e agentes reutilizáveis com acompanhamento local |

| [0010](0010-default-code-review.md) | Aceito | Code review incluído uma vez, editável e removível |
| [0011](0011-shared-ui.md) | Aceito | primitivas compartilhadas de interface |
| [0012](0012-provider-accounts.md) | Aceito | contas locais e seleção global por provider |
| [0013](0013-remove-provider-accounts.md) | Aceito | remoção de contas e seleção vazia |
