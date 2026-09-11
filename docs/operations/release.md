# CI e release

## Commits

O repositório usa Conventional Commits em português:

```text
tipo(escopo): descrição
```

`feat`, `fix` e `perf` aparecem no changelog. Durante a série 0.x, mudanças
normais sobem patch e breaking changes sobem minor conforme `cliff.toml`.
Esses tipos e `revert` incluem um rodapé `Release-EN` com a linha pública em
inglês. O `git-cliff` usa a descrição em português e esse rodapé para gerar uma
única seção de versão bilíngue. Marcadores HTML permitem que o app mostre só o
idioma escolhido, enquanto o GitHub mostra os dois.

O hook `.githooks/commit-msg` valida localmente e o job `commits` verifica cada
commit do PR.

## CI

`.github/workflows/ci.yml` roda em PRs, inclusive de forks, e em pushes para
`main`, em runners macOS hospedados pelo GitHub. O job instala dependências,
instala Chromium e WebKit e executa `npm run check`. Runners hospedados são
descartáveis e o workflow não tem segredo, então código de fork roda sem
risco. Não registre runner self-hosted neste repositório: o código é público
e um PR de fork controla o que o job executa. Ver
[ADR 0040](../decisions/0040-open-source.md).

## Criar release

## Criar release

```sh
sh scripts/release.sh
sh scripts/release.sh 0.5.0
```

O script exige árvore limpa, branch `main`, paridade com `origin/main` e ao
menos uma nota pública desde a tag anterior. Ele calcula ou recebe
a versão, atualiza manifests e changelog, roda testes, cria commit/tag e envia
para o remoto.

O workflow de release constrói e assina os artefatos e cria uma draft neste
mesmo repositório, com o `GITHUB_TOKEN` do job. Não existe PAT de release.

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

Os assets não levam a versão no nome (`Prometeu_aarch64.dmg`). Isso mantém
`releases/latest/download/Prometeu_aarch64.dmg` válido para sempre, que é o link
do site: publicar troca a versão que o botão de download entrega, sem tocar no
repositório do site.

O updater não possui rollback para uma versão menor. Uma release publicada com
defeito precisa ser corrigida por uma versão seguinte.

## Chaves

A chave privada de assinatura nunca entra no repositório. A cópia local fica
em `~/.tauri/prometeu.key`; sua senha fica no Keychain sob o serviço
`prometeu-tauri-signing`. A CI usa os Secrets `TAURI_SIGNING_PRIVATE_KEY` e
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Perder a cópia local e os Secrets impede
atualizar instalações existentes.

Essa assinatura protege o updater. A distribuição no macOS também usa o
certificado `Developer ID Application: Gustavo Brancaglione (6MQT6A482B)` do
Keychain e notarização Apple. A CI importa uma cópia `.p12` em um Keychain
temporário usando `APPLE_CERTIFICATE` e `APPLE_CERTIFICATE_PASSWORD`, adiciona
esse Keychain à lista de busca sem trocar o Keychain padrão do Mac e depois o
remove. A notarização usa `APPLE_ID` e `APPLE_PASSWORD`; o segundo contém uma
senha específica de app, nunca a senha normal da conta Apple. O job falha antes
do build se certificado ou Secrets estiverem ausentes. O bundler notariza o app;
o workflow notariza e grampeia o DMG final, substitui o asset criado antes dessa
etapa e então usa `stapler` e `spctl` para validar a cópia baixada da draft.

Não execute corte, tag, push ou publicação como parte de uma tarefa comum sem
pedido explícito.
