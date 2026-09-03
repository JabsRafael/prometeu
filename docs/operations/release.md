# CI e release

## Commits

O repositório usa Conventional Commits em português:

```text
tipo(escopo): descrição
```

`feat`, `fix` e `perf` aparecem no changelog. Durante a série 0.x, mudanças
normais sobem patch e breaking changes sobem minor conforme `cliff.toml`.

O hook `.githooks/commit-msg` valida localmente e o job `commits` verifica cada
commit do PR.

## CI

`.github/workflows/ci.yml` roda em PRs internos e pushes para `main` num runner
self-hosted macOS ARM64. O job instala dependências, instala Chromium e executa
`npm run check`.

O repositório deve permanecer privado e workflows de forks desativados enquanto
o runner self-hosted estiver registrado: checkout, npm e testes executam código
do branch.

## Criar release

```sh
sh scripts/release.sh
sh scripts/release.sh 0.5.0
```

O script exige árvore limpa, branch `main`, paridade com `origin/main`, runner
online e ao menos uma nota pública desde a tag anterior. Ele calcula ou recebe
a versão, atualiza manifests e changelog, roda testes, cria commit/tag e envia
para o remoto.

O workflow de release constrói e assina os artefatos e cria uma draft no
repositório público de releases.

## Publicar

Entre build e publicação existe uma verificação humana:

1. baixar o `.dmg` da draft;
2. instalar e abrir o app;
3. validar os fluxos afetados pela versão;
4. confirmar que todos os assets e o workflow estão completos;
5. publicar com:

```sh
sh scripts/release.sh publish
```

O updater não possui rollback para uma versão menor. Uma release publicada com
defeito precisa ser corrigida por uma versão seguinte.

## Chaves

A chave privada de assinatura nunca entra no repositório. A cópia local fica
em `~/.tauri/prometheus.key`, com senha no Keychain; a CI usa Secrets do
repositório. Perder ambas impede atualizar instalações existentes.

Não execute corte, tag, push ou publicação como parte de uma tarefa comum sem
pedido explícito.
