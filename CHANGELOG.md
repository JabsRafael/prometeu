# Changelog

O que muda no Prometheus, versão a versão, para quem usa o app.
As versões saem de `sh scripts/release.sh`; este arquivo é gerado a partir dos
commits pelo git-cliff, e as notas de cada release no GitHub são a seção dela.

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
