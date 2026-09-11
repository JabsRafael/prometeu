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

- [Feedback privado](contracts/feedback.md): widget com conta, texto e imagens no GitHub privado.

- [Organizações no Cloud](contracts/cloud-organizations.md): CRUD, convites, catálogos e acesso ao relay.

- [Catálogo na conta Prometeu](contracts/cloud-catalog.md): plugins, MCP e skills gerenciados no SaaS, com itens privados e compartilhamento explícito no desktop.
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
- [`contracts/relay-v4.md`](contracts/relay-v4.md): colaboração cifrada e TOFU.
- [`contracts/relay-v3.md`](contracts/relay-v3.md): histórico do protocolo sem E2EE.

## Decisões

- [Decision index and lifecycle](decisions/README.md).
- [ADR 0001](decisions/0001-repository-knowledge.md): conhecimento do repositório como fonte de verdade — Aceito.
- [ADR 0002](decisions/0002-canonical-conversation-protocol.md): protocolo canônico de conversa — Aceito; espelho substituído.
- [ADR 0003](decisions/0003-agent-capabilities.md): features dirigidas por capacidades — Aceito.
- [ADR 0004](decisions/0004-prometeu-independent-identity.md): identidade independente do Prometeu — Aceito.
- [ADR 0005](decisions/0005-portable-plugin-marketplace.md): marketplace portátil para Claude e Codex — Aceito.
- [ADR 0006](decisions/0006-explicit-prometheus-import.md): importação explícita e não destrutiva do Prometheus — Aceito; importador removido.
- [ADR 0007](decisions/0007-persistent-session-comments.md): comentários persistentes ao lado da sessão — Aceito.
- [ADR 0008](decisions/0008-explicit-git-index.md): índice Git explícito e operações por repositório — Aceito.
- [ADR 0009](decisions/0009-reusable-actions.md): comandos e agentes reutilizáveis com acompanhamento local — Aceito.
- [ADR 0010](decisions/0010-default-code-review.md): Code review incluído uma vez, editável e removível — Aceito.
- [ADR 0011](decisions/0011-shared-ui.md): primitivas compartilhadas de interface — Parcialmente substituído pelo 0016.
- [ADR 0012](decisions/0012-provider-accounts.md): contas locais e seleção global por provider — Aceito.
- [ADR 0013](decisions/0013-remove-provider-accounts.md): remoção de contas e seleção vazia — Aceito.
- [ADR 0014](decisions/0014-optional-cloud-account.md): conta opcional e SaaS separado — Substituído (stack).
- [ADR 0015](decisions/0015-cloud-rails.md): SaaS em Rails com contrato desktop preservado — Aceito.
- [ADR 0016](decisions/0016-company-design-system.md): Design System distribuível para os produtos da empresa — Parcialmente substituído pelo 0017.
- [ADR 0017](decisions/0017-executable-design-system.md): componentes executáveis e adaptador Rails do Design System — Aceito.
- [ADR 0018](decisions/0018-native-file-promises.md): recebimento nativo de miniaturas e promessas de arquivos — Aceito.
- [ADR 0019](decisions/0019-cloud-catalog.md): catálogo portátil de plugins, MCP e Ações na conta Prometeu — Substituído pelo 0020.
- [ADR 0020](decisions/0020-personal-catalog-and-local-items.md): autoria no SaaS e compartilhamento explícito de itens locais — Parcialmente substituído pelo 0021.
- [ADR 0021](decisions/0021-cloud-organizations.md): organizações, convites por email e colaboração autorizada pelo Cloud — Aceito.
- [ADR 0022](decisions/0022-end-to-end-encryption.md): criptografia ponta a ponta, TOFU e limites de segurança — Aceito.
- [ADR 0023](decisions/0023-ordered-publication.md): ordered board publication and conversation delivery — Accepted.
- [ADR 0024](decisions/0024-typed-ipc.md): command-owned IPC arguments and results — Accepted.
- [ADR 0025](decisions/0025-completion-sound-per-execution.md): som de conclusão por execução aceita, independente da leitura — Parcialmente substituído pelo 0029.
- [ADR 0026](decisions/0026-portable-collaboration-core.md): núcleo de colaboração portável e acesso pelo celular via relay — Aceito; etapas decididas nos ADRs 0027 e 0028.
- [ADR 0027](decisions/0027-companion-devices.md): dispositivos companheiros no relay com campo aditivo `person` — Aceito; ampliado pelo 0036.
- [ADR 0028](decisions/0028-mobile-web-app.md): Prometeu no celular como app web servido pelo Cloud — Aceito.
- [ADR 0029](decisions/0029-remove-alert-sound.md): remoção dos avisos sonoros, preservando indicadores visuais — Aceito.
- [ADR 0030](decisions/0030-remote-control.md): controle remoto pessoal independente da audiência do time — Aceito.

- [ADR 0031](decisions/0031-public-feedback.md): feedback público pelo Cloud e GitHub Issues — Substituído pelo 0032.

- [ADR 0032](decisions/0032-private-feedback.md): feedback privado no repositório do Cloud — Substituído pelo 0033.
- [ADR 0033](decisions/0033-github-feedback-attachments.md): texto e imagens de feedback no GitHub — Substituído pelo 0035.
- [ADR 0034](decisions/0034-mobile-pairing-continuity.md): renovação do relay sem desconexão e continuidade do pareamento móvel — Aceito.
- [ADR 0035](decisions/0035-feedback-requires-account.md): feedback exige conta Prometeu — Aceito.
- [ADR 0036](decisions/0036-second-mac-as-companion.md): segundo Mac da mesma conta entra como dispositivo companheiro — Aceito.

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
