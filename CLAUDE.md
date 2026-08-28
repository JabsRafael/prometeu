# Prometheus

App de desktop (Tauri 2 + Vite/TypeScript) que organiza sessões de agente por
workspace — Claude Code (`claude -p` stream-json, `src-tauri/src/chat.rs`), ou
o Codex quando o modelo escolhido é um GPT (`codex app-server` traduzido para
as mesmas linhas em `src-tauri/src/codex.rs`; o catálogo de modelos está em
`agents.rs`). A conversa é desenhada pelo app (`src/timeline.ts`, `src/chat.ts`);
o terminal (xterm + pty) só serve setup, run e shells do dock.
O código fica neste repositório privado; os pacotes vão para o público
`gbrancaglione/prometheus-releases`, de onde o app instalado se atualiza
sozinho.

## Commits: Conventional Commits, em português

O `CHANGELOG.md`, as notas de cada release e o número da versão saem dos
commits (git-cliff, `cliff.toml`). O hook `.githooks/commit-msg` recusa o que
foge do formato, e o CI confere cada commit do PR.

```
tipo(escopo): descrição
```

- **tipos**: `feat`, `fix`, `perf` aparecem no changelog; `refactor`, `docs`,
  `test`, `chore`, `ci`, `build`, `style` não. `!` depois do tipo ou do escopo
  marca mudança que quebra (`feat(board)!: …`).
- **escopo** é a parte do app, como quem usa a chama: `lançador`, `quadro`,
  `terminal`, `dock`, `updater`, `release`. Opcional.
- **descrição** de `feat`/`fix`/`perf` é a linha que a pessoa vai ler no aviso
  de atualização. Escreva o que ela vê ou passa a conseguir fazer, em
  minúscula, sem ponto final, sem nome de arquivo, função ou módulo:
  - `feat(lançador): esforço e modelo no rodapé, e o modelo acompanha o workspace`
  - `fix(quadro): arrastar card entre colunas volta a funcionar`
  - `refactor(pty): signal_group recebe o pid em vez do handle` — não aparece
    para ninguém, pode falar de código à vontade
- O corpo do commit continua livre: é ali que vai o porquê, para quem mexe no
  código.

## Versão e release

Enquanto a versão é 0.x: `feat` e `fix` sobem o patch, mudança que quebra sobe
o minor. Soltar é `/release` (ou `sh scripts/release.sh`); o fluxo inteiro está
no cabeçalho de `scripts/release.sh` e em `.github/workflows/release.yml`. Em
resumo: tag → CI constrói e assina → **draft** no repo público → alguém instala
e confere → `sh scripts/release.sh publish`.

A chave de assinatura (`~/.tauri/prometheus.key` + senha no Keychain, e uma
cópia nos Secrets do repositório) é o que permite atualizar quem já instalou.
Ela não entra em repositório nenhum.

## PR e CI

Trabalho sai em branch e entra por PR: `/open-pr` empurra, escreve o PR e
acompanha os checks. O CI (`.github/workflows/ci.yml`) roda no runner
self-hosted deste Mac — `~/actions-runner`, serviço de login; `sh
scripts/runner.sh` confere se está online e sobe se não estiver. Runner
parado = job na fila por até 24h, sem aviso. O repositório precisa continuar
privado enquanto houver runner self-hosted nele.

## Texto na tela

A tela fala português e inglês. Toda frase que alguém lê passa pelo catálogo:
`src/i18n.pt.ts` é a fonte (é dele que sai o tipo `Key`), e `src/i18n.en.ts` é
um `Record` sobre as mesmas chaves — chave nova sem tradução não compila.

- No TypeScript: `t("chave")`, `t("chave", { buraco: valor })`, `tn(n, "chave")`
  para singular/plural. O que está escrito direto no `index.html` ganha
  `data-t` (texto) ou `data-t-title` (o `title`), e o `paint()` do boot resolve.
- No Rust: `i18n::t("err.algo")` e `i18n::ta("err.algo", &[("path", …)])`. O back
  nunca escreve frase — escreve código, e quem traduz é o `fromBack` do front.
  Erro que chega do back sempre passa por `fromBack(e)`, nunca por `String(e)`.
- O que o agente escreve (saída do terminal, pergunta dele, plano) e o que a
  pessoa escreveu (nome do workspace, etapa, branch) não são tela: ficam como
  estão.

O idioma sai do `navigator.language` e só; escolher outro grava em
`localStorage` (`prometheus:idioma`) e recarrega a janela.

## Rodar

`npm run app` sobe o app de dev isolado por worktree; `npm test` roda vitest e
`cargo test`; `npm run build` faz o type-check e o bundle do front.
