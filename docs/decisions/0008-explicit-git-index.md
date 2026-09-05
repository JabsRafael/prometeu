# ADR 0008 — índice Git explícito e operações por repositório

Data: 2026-09-05
Status: Aceito

## Contexto

Mudanças reunia commits da branch e modificações locais num diff desde a merge
base. O filtro de arquivos sujos não mudava a base dos patches. Esse modelo
servia para revisão, mas não descrevia o índice necessário para preparar um
commit. Sessões de agentes também podem continuar editando enquanto a pessoa
revisa, e um workspace pode conter vários repositórios independentes.

## Opções consideradas

1. Acrescentar stage ao diff existente, mantendo patches misturados.
2. Expor índice, worktree e conflitos separadamente, preservando revisão de
   branch e histórico como comparações explícitas.
3. Delegar todas as operações ao agente ou a um cliente Git externo.

## Decisão

Adotar a segunda opção. A UI prepara e commita por repositório, e separa commit
local de push. O backend resolve caminhos a partir do workspace e possui as
operações Git; apresentação não executa comandos do shell. Os novos comandos
são aditivos ao IPC existente, descritos em
[`../contracts/git.md`](../contracts/git.md).

A seleção de branch reutiliza o lançador e o lifecycle de worktrees. Não troca
o checkout do workspace que mantém conversas em execução. O avatar de inicial
colorida permanece a identidade visual do repositório.

## Consequências

- Arquivos parcialmente preparados aparecem nos dois grupos, com patches
  específicos. Novas edições do agente permanecem fora do commit.
- Contadores locais e contadores de upstream têm significados distintos.
- Erros de Git ficam explícitos; um repositório com falha não parece limpo.
- A UI guarda rascunhos e protege ações contra respostas de navegação antigas.
- O app não se torna um cliente Git completo: não acrescenta checkout sobre
  agentes, force-push, stage de linhas ou finalização de rebase.
- Não há mudança em persistência, contratos dos agentes ou relay.

## Evidência

Testes reais em `src-tauri/src/session/git_tests.rs`, UI em `e2e/git.spec.ts` e
paridade IPC em `src-tauri/tests/mock.rs`. A aprovação visual ocorreu num
protótipo temporário; esse artefato não faz parte da documentação versionada.
