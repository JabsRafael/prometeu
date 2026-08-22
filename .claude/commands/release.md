---
description: Solta uma versão nova do Prometheus — confere, escreve as notas e roda o script
argument-hint: [versão]
allowed-tools: Bash(git:*), Bash(gh release:*), Bash(sh scripts/release.sh:*), Bash(cat:*), Bash(python3:*), Read
---

Você vai soltar uma versão do Prometheus. O trabalho pesado é do
`scripts/release.sh`; o seu é decidir a versão, escrever as notas e não deixar
passar nada quebrado.

Versão pedida: **$1** (vazio = incrementar o último número do `package.json`).

## 1. Onde você está

- branch e sujeira: !`git rev-parse --abbrev-ref HEAD; git status --porcelain | head -5`
- worktrees deste repo: !`git worktree list | head -3`

Release sai do **clone principal, na main, com a árvore limpa**. Se a saída
acima mostrar outra branch ou um worktree, **pare**: diga em qual pasta o clone
principal está (é a primeira linha do `git worktree list`) e que o release sai
de lá, depois que o trabalho estiver mergeado.

## 2. O que mudou

- versão atual: !`node -p "require('./package.json').version"`
- commits desde a última tag: !`sh -c 'T=$(git describe --tags --abbrev=0 2>/dev/null); echo "última tag: ${T:-nenhuma}"; git log --reverse --pretty="- %s" ${T:+$T..}HEAD'`
- tamanho da mudança: !`sh -c 'T=$(git describe --tags --abbrev=0 2>/dev/null); git diff --stat ${T:+$T..}HEAD | tail -1'`

Leia os commits e, quando não estiver claro o que uma mudança faz na tela, abra
o diff dela antes de escrever qualquer coisa a respeito.

## 3. As notas

Escreva de 1 a 5 linhas **para quem usa o app**, em português, começando cada
uma com `- `. As regras:

- fale do que a pessoa vê ou passa a conseguir fazer, não do código
- nada de nome de arquivo, de função ou de módulo
- nada de "refactor", "bump", "fix": diga o que estava ruim e o que ficou bom
- não prometa o que você não conferiu no diff

Mostre as notas e a versão para o usuário e **espere ele aprovar**. Se ele
mudar uma palavra, é a palavra dele que vai.

## 4. Soltar

Com o aval, rode — as notas vão no segundo argumento, senão o script tenta
abrir um editor que não existe aqui dentro:

```sh
sh scripts/release.sh <versão> "<as notas aprovadas>"
```

Ele marca os quatro arquivos de versão, roda os testes, commita, tagueia,
constrói assinado, escreve o `latest.json` e publica em
`gbrancaglione/prometheus-releases`. Demora uns dois minutos por causa do cargo.

Se ele parar no meio, **leia o erro antes de tentar de novo**: teste vermelho,
árvore suja e chave de assinatura ilegível são coisas diferentes, e nenhuma se
resolve rodando o comando outra vez.

## 5. Depois

Diga ao usuário a URL da release e que o Prometheus instalado mostra o aviso no
rodapé quando ele fechar e abrir de novo — ou em até seis horas, se deixar
aberto.

Duas coisas que você **não** faz: republicar um pacote por cima de um nome que
já existe (o CDN do GitHub serve o antigo por vários minutos — o certo é soltar
a versão seguinte), e usar `--force` em qualquer git daqui.
