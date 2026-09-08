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
| [0011](0011-shared-ui.md) | Parcialmente substituído pelo 0016 | primitivas compartilhadas de interface |
| [0012](0012-provider-accounts.md) | Aceito | contas locais e seleção global por provider |
| [0013](0013-remove-provider-accounts.md) | Aceito | remoção de contas e seleção vazia |
| [0014](0014-optional-cloud-account.md) | Substituído (stack) | conta opcional e SaaS separado |
| [0015](0015-cloud-rails.md) | Aceito | SaaS em Rails com contrato desktop preservado |
| [0016](0016-company-design-system.md) | Parcialmente substituído pelo 0017 | Design System distribuível para os produtos da empresa |
| [0017](0017-executable-design-system.md) | Aceito | componentes executáveis e adaptador Rails do Design System |
| [0018](0018-native-file-promises.md) | Aceito | recebimento nativo de miniaturas e promessas de arquivos |
| [0019](0019-cloud-catalog.md) | Substituído pelo 0020 | catálogo portátil de plugins, MCP e Ações na conta Prometeu |
| [0020](0020-personal-catalog-and-local-items.md) | Parcialmente substituído pelo 0021 | autoria no SaaS e compartilhamento explícito de itens locais |
| [0021](0021-cloud-organizations.md) | Aceito | organizações, convites por email e colaboração autorizada pelo Cloud |
| [0022](0022-end-to-end-encryption.md) | Aceito | criptografia ponta a ponta na colaboração |
| [0023](0023-ordered-publication.md) | Accepted | ordered board publication and conversation delivery |
| [0024](0024-typed-ipc.md) | Accepted | command-owned IPC arguments and results |
| [0025](0025-completion-sound-per-execution.md) | Parcialmente substituído pelo 0029 | som de conclusão por execução aceita |
| [0026](0026-portable-collaboration-core.md) | Aceito; etapas decididas no 0027 e no 0028 | núcleo de colaboração portável e acesso pelo celular via relay |
| [0027](0027-companion-devices.md) | Aceito | dispositivos companheiros no relay com campo aditivo `person` |
| [0028](0028-mobile-web-app.md) | Aceito | Prometeu no celular como app web servido pelo Cloud |
| [0029](0029-remove-alert-sound.md) | Aceito | remoção dos avisos sonoros, preservando indicadores visuais |
