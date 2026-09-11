# ADR 0040 — Código aberto em um único repositório público

Data: 2026-09-11
Status: Aceito. Substitui parcialmente o [ADR 0004](0004-prometeu-independent-identity.md)
quanto ao repositório de releases.

## Contexto

O código vivia em um repositório privado pessoal, com CI e release num runner
self-hosted neste Mac. As releases eram copiadas para
`prometeucorp/prometeu-releases`, público, porque o updater e o site precisam
de URLs públicas. Isso exigia um PAT da organização no workflow, um segundo
repositório para manter e um guarda que recusava o runner se o repositório
deixasse de ser privado.

O produto passa a ser código aberto. Com o código público, o repositório de
releases perde a razão de existir.

## Opções consideradas

1. Abrir o código e manter `prometeu-releases` como destino das releases.
2. Abrir o código em `prometeucorp/prometeu` e publicar releases nele mesmo.
3. Abrir o código mantendo o runner self-hosted para CI.

## Decisão

Opção 2. O repositório é transferido para `prometeucorp/prometeu` e fica
público. Releases, `latest.json` do updater e o link de download do site
apontam para ele. `prometeucorp/prometeu-releases` é arquivado.

CI e release rodam em runners macOS hospedados pelo GitHub, gratuitos para
repositório público. Runner self-hosted é proibido: em repositório público, um
PR de fork escolhe o `runs-on` do próprio workflow, e com isso executaria
código arbitrário neste Mac. O workflow de release usa o `GITHUB_TOKEN` do job
com `contents: write`; não há PAT.

O caminho de atualização é preservado por uma ponte única: depois da primeira
release publicada no repositório novo, o mesmo `latest.json` entra como release
em `prometeu-releases`. Instalações antigas leem o endpoint antigo, baixam o
pacote do repositório novo, e a partir daí passam a consultar o endpoint novo,
que já vem embutido nessa versão. A assinatura minisign não muda.

## Consequências

Positivas:

- um repositório só para código, issues, releases e histórico;
- nenhuma credencial de organização nos workflows;
- CI para PRs de forks sem expor a máquina do mantenedor;
- o Mac deixa de ser infraestrutura de build.

Negativas:

- build de release num runner frio leva mais tempo que o incremental local;
- os secrets de assinatura e notarização passam a viver em runners de
  terceiros, ainda restritos ao environment `release`;
- `prometeu-releases` precisa continuar servindo a ponte enquanto houver
  instalação anterior a essa mudança.

## Evidência

- `.github/workflows/ci.yml` e `release.yml` usam `macos-latest` e
  `GITHUB_TOKEN`;
- `src-tauri/tauri.conf.json` aponta o updater para `prometeucorp/prometeu`;
- `scripts/release.sh` publica no mesmo repositório;
- o job `verify` do release valida `latest.json` contra a chave pública do app.
