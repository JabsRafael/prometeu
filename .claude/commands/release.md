---
description: Solta uma versão nova do Prometeu — confere os commits, corta a tag, acompanha o CI e publica a draft
argument-hint: [versão | publish]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(sh scripts/release.sh:*), Bash(node_modules/.bin/git-cliff:*), Bash(cat:*), Bash(node:*), Read
---

Você vai soltar uma versão do Prometeu. O fluxo tem duas metades, e entre
elas existe uma pessoa:

1. **cortar** — `sh scripts/release.sh [versão]` calcula o número a partir dos
   commits, gera a seção do `CHANGELOG.md`, commita, tagueia, empurra e
   acompanha o CI, que constrói assinado e deixa uma release **draft** em
   `prometeucorp/prometeu`, o próprio repositório.
2. **publicar** — depois que o usuário instalou o `.dmg` da draft e conferiu,
   `sh scripts/release.sh publish` tira a draft do ar e o updater passa a
   entregá-la.

Argumento: **$1** (vazio = cortar com a versão calculada; `publish` = publicar
a draft da versão atual do `package.json`; `0.2.0` = cortar com essa versão).

## Se for `publish`

Pergunte ao usuário se ele instalou o `.dmg` da draft e abriu o app. Só com um
sim rode `sh scripts/release.sh publish`. O script confere sozinho que a draft
está inteira e que o CI deu verde; se ele recusar, leia o motivo — não há o que
forçar.

## Se for cortar

### 1. Onde você está

- branch e sujeira: !`git rev-parse --abbrev-ref HEAD; git status --porcelain | head -5`
- worktrees deste repo: !`git worktree list | head -3`

Release sai do **clone principal, na main, com a árvore limpa e igual à
origin/main**. Se a saída acima mostrar outra branch ou um worktree, **pare**:
diga em qual pasta o clone principal está (é a primeira linha do `git worktree
list`) e que o release sai de lá, depois que o trabalho estiver mergeado.

### 2. O que vai sair

- versão atual: !`node -p "require('./package.json').version"`
- versão calculada: !`node_modules/.bin/git-cliff --bumped-version 2>/dev/null || echo "(git-cliff não instalado — rode npm install)"`
- as notas, como o git-cliff as gera dos commits: !`node_modules/.bin/git-cliff --unreleased --bump --strip all 2>/dev/null`

As notas **são** os commits `feat`, `fix` e `perf` desde a última tag — não há
etapa de escrever notas. Leia o que saiu com o olho de quem usa o app:

- linha que fala de arquivo, função ou módulo está errada; linha que diz o que
  a pessoa vê ou passa a conseguir fazer está certa
- se a lista estiver vazia, o script vai recusar: algum commit que importa
  entrou como `chore` ou `refactor`, ou não há o que soltar
- commit já está na main: **não** reescreva histórico para consertar uma
  linha. Mostre a linha ruim ao usuário e deixe ele decidir entre soltar assim
  ou fazer um commit `fix`/`feat` que conte a história direito

Mostre a versão e as notas ao usuário e **espere ele aprovar**.

### 3. Cortar

Com o aval:

```sh
sh scripts/release.sh $1
```

Ele marca os quatro arquivos de versão, prepende a seção ao `CHANGELOG.md`,
roda os testes, commita `chore(release): vX.Y.Z`, tagueia, empurra e fica
acompanhando o run do `release.yml` (roda num runner macOS do GitHub; build,
assinatura e notarização levam perto de meia hora), imprimindo o estado a
cada trinta segundos. Deixe rodar.

Se o script parar antes de empurrar, **leia o erro antes de tentar de novo**:
árvore suja, main atrás da origin, teste vermelho e "nada para contar" são
coisas diferentes, e nenhuma se resolve rodando o comando outra vez. Se o CI
ficar vermelho, a tag já está lá: investigue o log do run, conserte na main
com um commit `fix`/`ci`, e a próxima versão leva o conserto — tag não se
reaproveita.

### 4. Depois

Diga ao usuário a URL da draft e o que falta: baixar o `.dmg`, instalar por
cima, abrir, e então `/release publish`. Quem já tem o Prometeu instalado só
fica sabendo depois do publish — no rodapé, ao abrir o app ou em até seis
horas.

Duas coisas que você **não** faz: republicar um pacote por cima de um nome que
já existe (o CDN do GitHub serve o antigo por vários minutos — o certo é soltar
a versão seguinte), e usar `--force` em qualquer git daqui.
