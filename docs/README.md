# Documentação do Prometeu

Este diretório é a fonte de verdade técnica do projeto. `AGENTS.md` funciona
como índice curto para agentes e `README.md` apresenta o produto.

## Arquitetura

- [Design System](architecture/design-system.md): tokens, componentes, galeria e adoção incremental.

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md): mapa geral do sistema.
- [`architecture/conversation-flow.md`](architecture/conversation-flow.md):
  caminho de uma conversa e ownership do estado.
- [`architecture/dependency-rules.md`](architecture/dependency-rules.md):
  regras entre apresentação, aplicação, domínio e adapters.

## Contratos

- [Catálogo na conta Prometeu](contracts/cloud-catalog.md): plugins, MCP e Ações
  que valem em todos os Macs da pessoa; instalação e segredos ficam por Mac.
- [Conta opcional do Prometeu](contracts/cloud-account.md): SaaS, autenticação
  pelo navegador, conexão do desktop e persistência privada.

- [Ações reutilizáveis](contracts/actions.md): comandos, perfis e acompanhamento local de PR.
- [`contracts/accounts.md`](contracts/accounts.md): contas, login, seleção
  global e isolamento de cotas dos agentes.

- [`contracts/conversation-events-v1.md`](contracts/conversation-events-v1.md):
  protocolo canônico pertencente ao Prometeu.
- [`contracts/agent-runtime.md`](contracts/agent-runtime.md): descoberta,
  capacidades e port de execução dos agentes.
- [`contracts/plugin-marketplace.md`](contracts/plugin-marketplace.md): hub,
  pacote portátil e adaptação por provider.
- [`contracts/ipc.md`](contracts/ipc.md): fronteira TypeScript/Rust.
- [`contracts/git.md`](contracts/git.md): índice, worktree, revisão e operações Git.
- [`contracts/persistence.md`](contracts/persistence.md): board e transcripts.
- [`contracts/relay-v3.md`](contracts/relay-v3.md): protocolo de colaboração.

## Decisões

- [ADR 0018](decisions/0018-native-file-promises.md): miniaturas de captura e promessas de arquivos no macOS.

- [ADR 0017](decisions/0017-executable-design-system.md): componentes executáveis, comportamento compartilhado e adaptação Rails.

- [ADR 0016](decisions/0016-company-design-system.md): Design System compartilhado da empresa, pacote e consumo pelo Cloud.

- [ADR 0014](decisions/0014-optional-cloud-account.md): conta opcional e SaaS separado — stack substituída pelo ADR 0015.
- [ADR 0015](decisions/0015-cloud-rails.md): SaaS em Rails com contrato desktop preservado — aceito.

- [ADR 0011](decisions/0011-shared-ui.md): primitivas compartilhadas de interface — localização dos assets substituída pelo ADR 0016.
- [`decisions/0013-remove-provider-accounts.md`](decisions/0013-remove-provider-accounts.md):
  remoção de qualquer conta e seleção vazia — aceita.
- [`decisions/0012-provider-accounts.md`](decisions/0012-provider-accounts.md):
  contas locais e troca entre turnos — aceita.

- [`decisions/README.md`](decisions/README.md): índice e ciclo de vida dos ADRs.
- [`decisions/0001-repository-knowledge.md`](decisions/0001-repository-knowledge.md):
  documentação versionada como fonte de verdade.
- [`decisions/0002-canonical-conversation-protocol.md`](decisions/0002-canonical-conversation-protocol.md):
  normalização dos protocolos de agentes — aceita.
- [`decisions/0003-agent-capabilities.md`](decisions/0003-agent-capabilities.md):
  disponibilidade de features por capacidades — aceita.
- [`decisions/0004-prometeu-independent-identity.md`](decisions/0004-prometeu-independent-identity.md):
  identidade, persistência e release independentes do produto anterior — aceita.
- [`decisions/0005-portable-plugin-marketplace.md`](decisions/0005-portable-plugin-marketplace.md):
  um marketplace de plugins para Claude e Codex — aceita.
- [`decisions/0006-explicit-prometheus-import.md`](decisions/0006-explicit-prometheus-import.md):
  importação explícita dos dados da instalação anterior — aceita.
- [`decisions/0007-persistent-session-comments.md`](decisions/0007-persistent-session-comments.md):
  comentários persistentes ao lado da sessão — aceita.
- [`decisions/0008-explicit-git-index.md`](decisions/0008-explicit-git-index.md):
  índice Git explícito e operações por repositório — aceita.

- [ADR 0009](decisions/0009-reusable-actions.md): comandos e agentes reutilizáveis — aceito.

- [ADR 0010](decisions/0010-default-code-review.md): Code review incluído no cadastro — aceito.

- [ADR 0019](decisions/0019-cloud-catalog.md): catálogo de plugins, MCP e Ações na conta — aceito.

## Qualidade e operação

- [`quality/provider-matrix.md`](quality/provider-matrix.md): suporte por agente
  e evidência esperada.
- [`operations/development.md`](operations/development.md): ambiente e testes.
- [`operations/release.md`](operations/release.md): CI, versionamento e release.

## Regra de atualização

Uma mudança deve atualizar o documento que responde à pergunta afetada:

- comportamento visível: `README.md` ou documentação da feature;
- responsabilidade ou fluxo: arquitetura;
- formato entre camadas: contrato;
- escolha e trade-offs: ADR;
- suporte por agente: matriz de providers;
- build, teste ou publicação: operação.

Documentação proposta deve declarar seu status. Ela não descreve o sistema
atual até que a implementação correspondente seja aceita.

## Referências da abordagem

- [OpenAI — Harness engineering](https://openai.com/index/harness-engineering/):
  `AGENTS.md` curto como mapa e `docs/` versionado como fonte de verdade.
- [AGENTS.md](https://agents.md/): formato comum de instruções para agentes.
- [Claude Code — project memory](https://code.claude.com/docs/en/memory):
  instruções concisas e escopadas no repositório.
- [C4 Model](https://c4model.com/diagrams): contexto e containers para o mapa
  arquitetural.
- [AWS — Architecture Decision Records](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html):
  contexto, decisão, consequências e ciclo de vida de ADRs.
