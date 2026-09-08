# Design System do Prometeu

Status: componentes executáveis compartilhados; decisão no
[ADR 0017](../decisions/0017-executable-design-system.md). O pacote contém
renderização, comportamento, estilos e adaptação Rails.

## Fonte de verdade

- [`packages/design-system`](../../packages/design-system/README.md): pacote
  `@prometeu/design-system`, fonte canônica de cores, fontes, raios,
  espaçamentos, controles DOM, menus, diálogos, ícones, estilos e adaptador
  Rails. Nomes e valores dos tokens são preservados. O pacote documenta APIs,
  importação, lifecycle e contratos de acessibilidade.
- [`src/ui-tokens.css`](../../src/ui-tokens.css): importa os tokens e conserva
  somente a geometria e os estados exclusivos do desktop.
- [`src/ui.css`](../../src/ui.css): importa os componentes compartilhados e
  adapta somente controles antigos ao desktop. `style.css` importa essa
  base; estilos de composição das telas continuam nas telas.
- [`src/ui.ts`](../../src/ui.ts): reexporta os componentes do pacote, sem
  implementação local de `button`, `input`, `field`, `checkbox`, `select`,
  `dropdown`, `disclosure` ou `formDialog`.
- [`src/menu.ts`](../../src/menu.ts) e [`src/icons.ts`](../../src/icons.ts):
  reexportam menus e ícones genéricos do pacote. Ícones de etapas, arquivos e
  providers continuam no adaptador de apresentação do desktop.

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
usa `root` e os atributos `name`/`required` quando o consumidor depende de
submissão nativa. O campo `native` participa de `FormData` e da validação HTML.
Telas antigas que usam apenas `control` e enviam comandos próprios continuam
validando as regras de domínio antes de salvar.
Opening a dropdown focuses its menu options. Arrow keys move actual focus,
not only the visual selection, and closing restores focus to the trigger.

`formDialog` usa `dialog.showModal()`: conteúdo atrás fica inerte, foco retorna
ao fechar e Tab/Shift+Tab circulam no formulário. O corpo rola e o rodapé fica
visível. Salvar respeita validação HTML, impede envio duplicado, sinaliza
`aria-busy` e apresenta falhas em `role="alert"` sem perder o texto digitado.
Menus abertos no diálogo entram na mesma camada. Escape fecha primeiro o menu;
outro Escape fecha o diálogo. Atalhos globais não alteram o workspace enquanto
o diálogo está aberto. While submission is pending, Escape and cancellation
leave the dialog open so progress and failures remain visible.

## Adoção

Editores de comandos e agentes em Ações usam os campos, seletores, checkboxes,
disclosures e diálogo compartilhados. O launcher usa o mesmo dropdown; campos
de texto dos hubs MCP e plugins usam `input` e `field`, incluindo o pedido de
criação de plugin. Worktree cleanup and legacy import also use `formDialog`,
including its busy-state cancellation guard and shared checkboxes. Their
application callbacks own progress labels and operation results. Modais antigos
dos hubs continuam com o lifecycle anterior.

Novos controles e alterações de controles existentes devem reutilizar essa
base. Se faltar comportamento, acrescente à primitiva correspondente e mostre
o estado na galeria. Não copie CSS de uma tela para outra, nem introduza um
componente para uma composição que só existe em uma tela.

## Galeria e verificação

`/packages/design-system/index.html` é a galeria independente da empresa:
renderiza componentes pela API compilada do pacote, sem estilos ou JavaScript
do app. Mostra menu, submenu por teclado, senha, seleção e diálogo assíncrono
com falha simulada. O Cloud consome runtime, estilos e adaptador Ruby em
`vendor/design-system`, importados por `bin/design-system` e verificados por
SHA-256 no CI. Suas views usam `ds_form_with`, `form.field`, `form.button` e
os helpers do pacote, que mantêm o markup fora das telas.
Desktop e telas de aplicativo do Cloud usam a densidade compacta padrão;
`ui-comfortable` (44px) fica para os fluxos de toque do Cloud, como login e
autorização do Mac. Mudanças começam no pacote e chegam ao Cloud por nova
importação, nunca por edição dos arquivos vendorizados.

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
