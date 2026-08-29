---
description: Abre um PR da branch atual — empurra, escreve título e corpo e acompanha os checks até o fim
argument-hint: [título]
allowed-tools: Bash(git:*), Bash(gh:*), Read
---

Você vai abrir um pull request da branch em que está, e ficar de olho no CI
até ele terminar. O CI de PR roda numa VM descartável do GitHub; o runner
self-hosted deste Mac fica reservado ao workflow de release.

Título pedido: **$1** (vazio = você escreve).

## 1. Onde você está

- branch: !`git rev-parse --abbrev-ref HEAD`
- sujeira: !`git status --porcelain | head -5`
- PR já aberto para esta branch? !`gh pr view --json number,url,state -q '"#\(.number) \(.state) \(.url)"' 2>/dev/null || echo "nenhum"`

Regras:

- **Na `main`, pare.** PR sai de branch. Diga isso e não faça mais nada.
- **Árvore suja, pare.** Mostre o que está pendente e pergunte se commita —
  e, se for commitar, a mensagem segue o CLAUDE.md (`tipo(escopo): descrição`;
  o hook recusa o resto).
- Se já existe PR aberto, não crie outro: pule para o passo 5 e acompanhe o
  CI do push mais recente.

## 2. O que vai no PR

- commits desde a main: !`git fetch -q origin main 2>/dev/null; git log --reverse --pretty="- %s" origin/main..HEAD`
- tamanho: !`git diff --stat origin/main..HEAD | tail -1`

Leia os commits. Se algum muda o que a pessoa vê na tela e você não tem
certeza do que faz, abra o diff dele antes de escrever.

## 3. Push

```sh
git push -u origin HEAD
```

## 4. Abrir

Título: um commit só → o assunto dele; vários → uma linha no mesmo formato
dos commits (`tipo(escopo): o que muda`), ou o que o usuário pediu em `$1`.

Corpo, em português, neste formato — é o que se lê daqui a seis meses:

```
## O que muda

Primeiro o que a pessoa que usa o app percebe; depois, se houver, o que mudou
por dentro e por quê. Parágrafos curtos, negrito no assunto de cada um.

## Como testei

O que rodou e o que foi conferido na mão. Se nada foi conferido na tela,
diga isso — não invente.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

```sh
gh pr create --title "<título>" --body "<corpo>"
```

## 5. Acompanhar o CI

Rode em segundo plano e continue disponível para o usuário:

```sh
gh pr checks --watch --fail-fast
```

Quando terminar:

- **verde** — diga a URL do PR e pergunte se mergeia. Com o sim:
  `gh pr merge --merge --delete-branch`. A main recebe o merge e o CI roda de
  novo nela; não precisa esperar.
- **vermelho** — `gh run view <id> --log-failed` (o id está na saída do
  `checks`), leia o erro e explique o que quebrou antes de mexer em qualquer
  coisa. Conserto é commit novo na branch (`fix`/`ci`/`test`, conforme o
  caso); o push reabre o ciclo a partir do passo 5.

Uma coisa que você **não** faz: `--force` em push. Histórico de branch
com PR aberto se conserta com commit por cima.
