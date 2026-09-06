# Design System do Prometeu

Status: implementado de forma incremental; decisão no [ADR 0011](../decisions/0011-shared-ui.md).

## Fonte de verdade

- [`src/ui-tokens.css`](../../src/ui-tokens.css): cores semânticas, fontes,
  raios, espaçamentos e altura dos controles. Os tokens anteriores mantêm os
  nomes e valores para preservar as telas existentes.
- [`src/ui.css`](../../src/ui.css): controles base e estados de foco, erro,
  seleção, desabilitado e envio. `style.css` importa essa base; estilos de
  composição das telas continuam nas telas.
- [`src/ui.ts`](../../src/ui.ts): `button`, `input`, `field`, `checkbox`,
  `select`, `dropdown`, `disclosure` e `formDialog`.
- [`src/menu.ts`](../../src/menu.ts) e [`src/icons.ts`](../../src/icons.ts):
  menus, tags e ícones compartilhados, sem biblioteca adicional.

Componentes recebem texto já traduzido e callbacks. Não importam IPC, estado
persistido, catálogo de agentes ou regras de negócio. Uma tela compõe essas
primitivas e mantém suas próprias validações de domínio.

## Uso e acessibilidade

`field(rótulo, controle, ajuda)` associa nome e descrição ao controle. `input`
mantém `required`, `pattern`, `min` e `max` nativos. Use `aria-invalid="true"`
e texto de erro associado quando a validação de domínio falhar. `checkbox`
mantém o input nativo dentro do rótulo, com tamanho independente de campos de
texto; rótulos longos quebram ao lado do controle.

`select` retorna `control`, `value`, `onchange` e `setOptions`. O seletor usa
o mesmo `dropdown` extraído do launcher e o menu compartilhado. A seleção de
modelo atualiza suas opções sem criar outro componente. Seleção obrigatória
é validada pela tela antes de salvar, pois o controle visível é um botão.

`formDialog` usa `dialog.showModal()`: conteúdo atrás fica inerte, foco retorna
ao fechar e Tab/Shift+Tab circulam no formulário. O corpo rola e o rodapé fica
visível. Salvar respeita validação HTML, impede envio duplicado, sinaliza
`aria-busy` e apresenta falhas em `role="alert"` sem perder o texto digitado.
Menus abertos no diálogo entram na mesma camada. Escape fecha primeiro o menu;
outro Escape fecha o diálogo. Atalhos globais não alteram o workspace enquanto
o diálogo está aberto.

## Adoção

Editores de comandos e agentes em Ações usam os campos, seletores, checkboxes,
disclosures e diálogo compartilhados. O launcher usa o mesmo dropdown; campos
de texto dos hubs MCP e plugins usam `input` e `field`, incluindo o pedido de
criação de plugin. Modais antigos dos hubs continuam com o lifecycle anterior.

Novos controles e alterações de controles existentes devem reutilizar essa
base. Se faltar comportamento, acrescente à primitiva correspondente e mostre
o estado na galeria. Não copie CSS de uma tela para outra, nem introduza um
componente para uma composição que só existe em uma tela.

## Galeria e verificação

Execute `npm run dev` e abra `/design-system.html` na mesma porta. A galeria
também é uma entrada do build web e não inicia o backend ou agentes. Mostra
tokens, botões, campos, seleção, erro, desabilitado, checkbox, menu com tag,
disclosure e formulário com sucesso ou falha simulada.

[`e2e/ui.spec.ts`](../../e2e/ui.spec.ts) cobre teclado, foco, validação,
falha recuperável e viewport estreito em Chromium e WebKit.
[`e2e/actions.spec.ts`](../../e2e/actions.spec.ts) cobre as primitivas nos
fluxos reais da feature nos dois motores. A checagem arquitetural impede que
`ui.ts` dependa de módulos de domínio ou que Ações recrie seletores nativos.
Os testes web e E2E existentes protegem launcher, menus e hubs durante adoção.
