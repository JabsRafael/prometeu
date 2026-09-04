# ADR 0002 — Protocolo canônico de conversa

Data: 2026-09-03
Status: Aceito; política de espelho substituída pelo ADR 0004

## Contexto

O frontend reduz stream-json do Claude. O adapter do Codex converte JSON-RPC
para esse mesmo formato, permitindo reutilizar timeline, transcript e
compartilhamento. A solução provou a utilidade de uma representação comum.

Entretanto, o formato comum pertence a um fornecedor, é consumido como JSON
dinâmico e mistura fatos da conversa com detalhes do protocolo do Claude.
Features exclusivas de outro provider precisam imitar conceitos externos ou
injetar subtipos próprios.

## Opções consideradas

1. Manter stream-json do Claude como contrato permanente.
2. Fazer o frontend conhecer e reduzir cada protocolo separadamente.
3. Criar eventos canônicos do Prometheus e adapters por provider.

## Decisão

Adotar `ConversationEventV1` e `ConversationCommandV1` como contratos internos
versionados. Cada provider traduz entrada e saída na borda. Timeline,
persistência e colaboração consomem somente o contrato do Prometheus.

A migração mantém leitura dos transcripts legados. O contrato vigente está em
`docs/contracts/conversation-events-v1.md`.

## Consequências

Positivas:

- provider novo não exige condicionais no reducer;
- eventos passam a ter parser, tipos e compatibilidade explícitos;
- testes de conformidade podem ser compartilhados;
- mudanças externas ficam concentradas nas fixtures do adapter.

Negativas:

- haverá um período com leitura e espelho de rollback em dois formatos;
- cada novo evento exige decisão de semântica comum;
- tradução pode perder detalhe específico do provider;
- transcripts e snapshot/live precisam de migração cuidadosa.

## Evidência de aceitação

- `conversation.test.ts` demonstra replay equivalente entre legado e V1;
- testes do reducer cobrem streaming, requests, background e compactação;
- testes Rust cobrem a tradução do stream-json e a tradução V1 direta do Codex;
- parser e adapters descartam evento desconhecido isoladamente;
- logs do Codex recebem espelho legado marcado, permitindo rollback sem
  reescrever transcripts.

## Decisões de detalhe

- anexo separado continua fora do V1 até existir transporte real de bytes;
- custo permanece no evento comum como campo anulável;
- slash commands continuam texto interpretado pelo adapter, com descoberta
  explícita por `commands.list`;
- notice traduzido e apresentável aparece; tipo externo desconhecido é no-op;
- o espelho `prometheusV1Mirror` é temporário, mas sua remoção exige novo ADR.

O ADR 0004 encerrou a emissão desse espelho na linha independente do Prometeu.
Os tokens legados continuam aceitos somente para leitura e importação futura.
