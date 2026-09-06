# ADR 0010 — Code review incluído no cadastro de ações

Data: 2026-09-05
Status: Aceito

## Contexto

O cadastro vazio exigia configurar um agente e um comando antes de experimentar
uma revisão. A tela também dava destaque excessivo à instalação manual de um
exemplo e aos ajustes do botão de PR.

## Decisão

Incluir o perfil editável **Code review**, associado a `/review`, na primeira
abertura após esta mudança. O perfil revisa alterações, relata achados e lacunas
de validação e termina o turno. Não publica PR, modifica arquivos ou acompanha
CI por padrão. Essas responsabilidades continuam configuráveis em outros perfis.

O campo aditivo `defaults_initialized` registra a inicialização. O default é
materializado no cadastro, em vez de ser uma camada implícita que reaparece
após remoção. Configuração existente com o mesmo comando ou identidade tem
precedência; não é substituída. O botão Open PR mantém a escolha da pessoa.

O JSON de origem é compartilhado pelo backend e pelo mock. Não há migração de
transcripts nem mudança na configuração das tarefas já iniciadas.

## Consequências

Há uma ação utilizável na primeira visita. A pessoa pode editar ou remover o
perfil e o comando sem que o app desfaça sua escolha ao reabrir. A tela dá
prioridade aos comandos, agrupa os agentes e recolhe os ajustes do botão de PR.

Esta decisão complementa o [ADR 0009](0009-reusable-actions.md), alterando apenas
o catálogo inicial; preserva seus contratos de execução e acompanhamento.

## Evidência

- [Default compartilhado](../../src/action-defaults.json).
- [Inicialização e compatibilidade](../../src-tauri/src/actions.rs).
- [Paridade do mock](../../src/actions.test.ts).
- [Cadastro, edição e remoção](../../e2e/actions.spec.ts).
