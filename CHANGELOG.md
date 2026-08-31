# Changelog

O que muda no Prometheus, versão a versão, para quem usa o app.
As versões saem de `sh scripts/release.sh`; este arquivo é gerado a partir dos
commits pelo git-cliff, e as notas de cada release no GitHub são a seção dela.

## [0.4.7] - 2026-08-31

### Correções

- **mudanças:** Arquivo não passa mais por cima do cabeçalho do repositório
- **barra:** Simplifica o topo e estabiliza seus estados
- **time:** Aviso de workspace fora do time não aparece mais sozinho

## [0.4.6] - 2026-08-30

### Novidades

- **conversa:** Aba nova pode falar com outro modelo, sem sair do workspace
- **lançador:** A lista de modelos não tem mais "Modelo padrão" — escolhe-se sempre um
- **mudanças:** O painel diz se os commits já foram para o remoto
- **barra:** Um botão de PR só, com os PRs de cada repositório num menu

### Correções

- **navegador:** Link clicado abre no navegador do computador, e a aba de dentro fica só no Run
- **lançador:** Branch do workspace novo leva o dia, e não repete nome já usado
- **mudanças:** Commit feito no terminal some da lista sem esperar o agente

### Desempenho

- **mudanças:** Workspace com muitos arquivos abre na hora e rola liso

## [0.4.5] - 2026-08-30

### Novidades

- **mudanças:** Workspace com mais de um repositório mostra as mudanças de todos, uma seção por repo
- **mudanças:** A tela mostra a branch inteira contra a base, com "visto" por arquivo e filtro do que está fora de commit
- **lançador:** Workspace com mais de um repositório tem um PR por repo, e "Concluir" só quando todos entraram

### Correções

- **mudanças:** As linhas de contexto do diff voltam a ser linhas, e não caixas
- **segurança:** Protege projetos, sessões e colaboração
- **interface:** Remove confirmação e recolhe erros técnicos

## [0.4.4] - 2026-08-29

### Novidades

- **lançador:** Um workspace pode juntar mais de um repositório, cada um num worktree na mesma branch

## [0.4.3] - 2026-08-29

### Novidades

- **conversa:** Escrever / na caixa lista os comandos e skills da sessão

## [0.4.2] - 2026-08-28

### Novidades

- **quadro:** Compartilhar um workspace só com alguns colegas do time

### Correções

- **conversa:** O texto da skill fica dentro do card dela, não como mensagem

## [0.4.1] - 2026-08-28

### Novidades

- **quadro:** Pling e bolinha no Dock quando um agente para ou uma nota te marca

### Correções

- **quadro:** Escolher um nome na lista do @ troca o que foi digitado em vez de repetir
- **chat:** Nota nova rola a conversa até o fim

## [0.4.0] - 2026-08-28

### Novidades

- **Quebra:** **quadro:** Remove o Kanban e usa Issues como tela inicial
- **conversa:** A conversa e o painel no desenho do Conductor

### Correções

- **codex:** Aceita caminhos absolutos e omite logs duplicados
- **conversa:** Cada workspace lembra se a caixa estava em fala ou nota
- **setup:** Preparar um worktree novo não quebra mais no meio

## [0.3.1] - 2026-08-28

### Novidades

- **conversa:** O trabalho seguido do agente vira um cartão só

### Correções

- **time:** Digitar @ na nota escreve o @, e escolher o nome completa ele
- **time:** Nota que não sai avisa, em vez de sumir com o que você escreveu

## [0.3.0] - 2026-08-28

### Novidades

- **quadro:** Marcar o vermelho na limpeza apaga o worktree do mesmo jeito
- **lançador:** Escolher um modelo GPT roda a sessão no Codex
- **conversa:** A conversa vira chat desenhado pelo app, com plano, pergunta e notas do time dentro dela
- **time:** Quem abre a conversa de um colega recebe a conversa inteira, não só o fim
- **conversa:** Perguntas do agente em abas, uma por pergunta, como na TUI
- **conversa:** A fala em espera do setup, o que roda em segundo plano, a compactação e o diff aparecem na tela
- **conversa:** /context vira um painel — barra por categoria e seções dobradas por servidor
- **conversa:** Escolher um GPT abre a conversa no Codex, com o mesmo chat
- **conversa:** O Codex faz pergunta com card, como o Claude Code

### Correções

- **conversa:** A primeira fala vai assim que a conversa sobe, e as seguintes não ficam presas
- **conversa:** O texto do agente quebra linha, chega sem tremer e mostra que está trabalhando
- **conversa:** Abrir "Pensando…" mostra o pensamento
- **conversa:** O caret some quando a mensagem termina, e "Pensou" perde a moldura tracejada
- **conversa:** Reabrir uma conversa não deixa a última mensagem "chegando"

### Desempenho

- **lançador:** Criar sessão abre na hora e o worktree prepara por trás

## [0.2.0] - 2026-08-27

### Novidades

- **time:** Criar um time, entrar com o código e ver quem está online, em Configurações
- **quadro:** Compartilhar um workspace com o time, e ver quem está olhando
- **terminal:** Abrir a conversa de um colega ao vivo, com a rolagem inteira e o teclado liberado
- **notas:** Comentar uma sessão — a sua ou a de um colega — citando o trecho do terminal

### Correções

- **time:** Dono que volta acorda o que compartilhou, e id de colega não colide com o seu

## [0.1.14] - 2026-08-26

### Novidades

- **quadro:** Os arquivados saem da barra e ganham uma tela com busca
- **dock:** Open abre o run numa janela do próprio app, e ⌥-clique no navegador
- **quadro:** O Run abre numa aba de navegador, ao lado da conversa
- **quadro:** A aba de navegador ganha barra de endereço
- **quadro:** Pergunta, plano e permissão ficam no terminal, sem card por cima

### Correções

- **quadro:** Limpar worktrees abre na hora e deixa de listar quem roda no próprio clone
- **dock:** A porta reservada nunca cai numa que o navegador recusa

## [0.1.13] - 2026-08-26

### Novidades

- **workspace:** Worktree novo já nasce com o .env do projeto
- **workspace:** PR aberto da branch aparece na barra e leva até ele no navegador
- **lançador:** Workspace novo ganha nome escrito pelo agente
- **quadro:** O PR que entrou vira "Concluir", e a barra devolve os worktrees ao disco

### Correções

- **quadro:** "Devolver worktrees" vira linha da barra, em vez de ícone que só o mouse achava
- **quadro:** A limpeza de worktree se chama "Limpar worktrees" na tela inteira

## [0.1.12] - 2026-08-25

### Novidades

- **quadro:** Barra lateral agrupa os workspaces por projeto, com a etapa na linha

## [0.1.11] - 2026-08-25

### Novidades

- **dock:** Worktree herda o settings.toml do clone, e a porta do Run não se repete entre worktrees
- **idioma:** O app fala inglês, e começa no idioma do computador
- **issues:** Recolher grupo de issues, e o grupo fechado continua fechado
- **updater:** Botão "Buscar atualizações" em Configurações, com a versão e a hora da última busca

## [0.1.10] - 2026-08-24

### Novidades

- **painel:** Arrastar a borda esquerda muda a largura do painel da direita
- **dock:** Botão Open abre o run no navegador enquanto ele está de pé
- **workspace:** Botão Open PR pede o pull request à conversa ativa

## [0.1.9] - 2026-08-24

### Novidades

- **configurações:** Conectar o Linear pela nova tela de configurações
- **issues:** Aba com as issues do Linear no seu nome, e criar workspace a partir de uma
- **lançador:** Sem a seção Detalhes — nome, branch e etapa saem sozinhos
- **lançador:** Escolher uma issue do Linear no próprio lançador

### Correções

- **updater:** Clicar em reiniciar depois de baixar a atualização reinicia o app de verdade

## [0.1.8] - 2026-08-23

### Outros

- Tira o aviso de "solto no seu clone" do rodapé
- O card mostra quantos tokens de contexto a conversa tem

## [0.1.7] - 2026-08-23

As notas até aqui foram escritas à mão; a partir da próxima, saem dos commits.

- Arrastar um card entre colunas do quadro volta a funcionar — antes o card parecia ir, mas só o menu do botão direito trocava a etapa. Esc desiste do arraste.
- O lançador ganha um rodapé com modelo, esforço e Plan: o modelo escolhido acompanha o workspace (⌘T e retomar nascem com o mesmo, e o card do quadro o mostra quando não é o padrão); o esforço sobe um degrau a cada clique, de Baixo a Máximo e depois Ultracode, e lembra o último.
- Com Plan ligado, a primeira conversa só lê e planeja; quando o plano fica pronto, um card pergunta se executa do jeito que está ou devolve ao terminal para ajustar.
- A chavinha Solto sai: toda sessão nasce solta. O aviso laranja fica só para o caso que merece — sem worktree, mexendo no clone em que você trabalha.
- Anexos aparecem entre o texto e o rodapé, e arquivo solto em cima do lançador aberto vira anexo em vez de cair no terminal. Escolher modelo, esforço, projeto ou Plan devolve o cursor ao texto.

## [0.1.6] - 2026-08-22

- A aba do que está rodando ganhou uma onda que se mexe, no lugar do ponto verde parado — dá para ver de longe que o Run continua de pé.
- O Terminal deixou de ser um só: o + abre outro, o ✕ fecha, e sair do shell fecha a aba sozinho. Cada worktree lembra os terminais que você deixou abertos.
- ⌘W com o cursor dentro do terminal fecha aquele terminal, e não a aba do centro.

## [0.1.5] - 2026-08-22

O painel de baixo ficou mais fácil de ler.

- A moldura tracejada saiu: ela parecia uma área de arrastar, e não era. O que a aba tem a dizer agora ocupa o painel inteiro, centrado.
- Título, explicação e botão passaram a ter tamanhos diferentes — antes tudo tinha o mesmo peso e nada guiava o olho.
- Um botão só chama a ação; a alternativa virou texto ao lado.
- O `⌘R` aparece dentro do botão de Run, que é de quem o atalho é.
- Entrar num workspace cai direto na aba Setup, onde está a saída de quando o worktree nasceu — inclusive o erro, se ele falhou.

## [0.1.4] - 2026-08-22

O app passa a se atualizar sozinho.

A partir desta versão, o Prometheus avisa no rodapé da barra lateral quando existe versão nova, baixa e troca o `.app` no lugar. O `.dmg` continua servindo para a primeira instalação — depois dela, não é mais preciso reinstalar nada.

Cada pacote é assinado, e o app recusa qualquer um que não bata com a chave que ele carrega dentro.
