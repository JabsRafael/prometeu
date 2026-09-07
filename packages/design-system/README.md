# Design System da Prometeu

`@prometeu/design-system` 0.4.0 distribui componentes executáveis: renderização,
estado, eventos, teclado, foco, validação, CSS e marca. A implementação vive
neste pacote. O desktop importa os componentes TypeScript; o Cloud usa o
adaptador Rails do pacote e o mesmo runtime JavaScript no navegador.

Não exige React, Vue, Web Components ou dependências JavaScript em runtime.
O adaptador Ruby usa Action View e FormBuilder nativos. Regras de negócio,
traduções e transporte permanecem nos produtos.

## Instalação e distribuição

Na raiz do repositório Prometeu:

```sh
npm run design-system:build
npm pack ./packages/design-system
```

O artefato `prometeu-design-system-0.4.0.tgz` inclui módulos ESM, declarações
TypeScript, bundle de navegador, adaptador Ruby, CSS, SVG e galeria. `prepack`
reconstrói o JavaScript para impedir a distribuição de código desatualizado.
O pacote ainda não foi publicado em um registry.

Em outro projeto:

```sh
npm install /caminho/prometeu-design-system-0.4.0.tgz
```

```ts
import { button, field, input, formDialog } from "@prometeu/design-system";
import "@prometeu/design-system/components.css";

const name = input("Equipe");
name.required = true;

const edit = button("Editar perfil", () => {
  const dialog = formDialog({
    title: "Editar perfil", save: "Salvar", cancel: "Cancelar",
    submit: async () => { await saveProfile({ name: name.value }); },
    error: () => "Não foi possível salvar. Tente novamente.",
  });
  dialog.body.append(field("Nome", name, "Como você aparece no produto."));
  dialog.open();
});
document.querySelector("main")!.append(edit);
```

`saveProfile` pertence ao consumidor. O componente cria o diálogo, associa
rótulos, valida o formulário, impede envio duplicado, controla estado de envio,
apresenta falhas sem perder dados e devolve o foco ao fechar. Não faz requests.

## Catálogo implementado

| API DOM/TypeScript | Responsabilidade |
| --- | --- |
| `button(label, callback, variant)` | botão nativo, variantes `outline`, `pri`, `ghost`, `danger`, foco e evento |
| `input(value, multiline)` | input ou textarea nativo; atributos HTML continuam disponíveis |
| `field(label, control, hint)` | estrutura de campo, rótulo, ID e descrição acessível |
| `checkbox(label, checked)` | input nativo e rótulo; retorna `control` e `label` |
| `password(value, {show, hide})` | campo e botão para revelar/ocultar sem substituir o valor |
| `select(value, options, attributes)` | seleção com menu, teclado, atualização de opções e campo nativo para submissão |
| `dropdown(button, groups, get, set)` | comportamento de seleção sobre um botão existente |
| `menuButton(label, items)` | menu de ações com foco, Escape, Home/End e submenus por teclado |
| `menu.openAt`, `menu.close`, `menu.onClose` | menu contextual e lifecycle; `onClose` devolve função de cancelamento |
| `formDialog(options)` | formulário modal assíncrono, validação, foco, estado de envio e recuperação de erro |
| `confirmDialog(options)` | confirmação acessível que resolve `Promise<boolean>` e aceita `AbortSignal` |
| `disclosure(title, ...content)` | disclosure nativo sem controle de estado externo |
| `card`, `badge`, `notice` | renderização de contêineres, indicadores e feedback com roles apropriados |
| `avatar(image, kind, size)` | foto ou logotipo; sem imagem, glifo de pessoa ou organização, decorativo |
| `icon(name, size)` | catálogo tipado de ícones vetoriais compartilhados |
| `enhance(root)` | conecta o HTML do adaptador Rails ao runtime; devolve função de limpeza |

`select` devolve `control`, `root`, `native`, `value`, `onchange` e `setOptions`.
Use `root` com `{ name, required, disabled }` para participar de um formulário
nativo: o seletor preserva validação e dados de `FormData`. `control` permanece
compatível com as telas antigas que leem `value` e enviam comandos próprios.

As primitivas recebem texto, não templates HTML. Rótulos, ajuda e erros usam
`textContent`. O slot `glyph` dos menus aceita somente SVG produzido pelo
próprio código; nunca passe HTML de usuários. Componentes retornam elementos
DOM e podem ser compostos dentro de qualquer host. Feche diálogos e menus ao
remover a tela; chame o retorno de `enhance` ao desmontar um host dinâmico.

## Rails

O pacote inclui `rails/prometeu_design_system.rb`. O Cloud importa uma versão
explícita, com os hashes de todos os arquivos:

```sh
bin/design-system ../prometeu/packages/design-system
bin/design-system --check ../prometeu/packages/design-system
```

`vendor/design-system/assets` contém CSS, SVG e `design-system.js` (bundle único,
sem imports remotos). `vendor/design-system/rails` contém o adaptador Ruby e
não entra no caminho público de assets. O servidor e o build do Cloud não
precisam de Node nem do checkout desktop. Para integrar outro Rails:

```ruby
require_relative "../../vendor/design-system/rails/prometeu_design_system"

module ApplicationHelper
  include Prometeu::DesignSystem::Helpers
end
```

```erb
<%= ds_form_with model: @user, url: account_path,
      password_labels: { show: "Mostrar senha", hide: "Ocultar senha" } do |form| %>
  <%= form.field :name, label: "Nome", required: true, autocomplete: "name" %>
  <%= form.field :password, label: "Senha", type: :password, required: true %>
  <%= form.button "Salvar", variant: :pri %>
<% end %>
```

O adaptador renderiza campos completos, rótulos, mensagens e botões. Não copie
seu markup para as views. `form.field` aceita `text`, `email`, `password`,
`textarea`, `number` e `date`. `form.checkbox` preserva o valor desmarcado nativo
do Rails. Helpers `ds_button_to`, `ds_link`, `ds_card`, `ds_badge`, `ds_notice`,
`ds_disclosure`, `ds_menu`, `ds_tabs` e `ds_avatar` compõem as demais primitivas
do servidor. `ds_menu` aceita `:sep` entre grupos, itens com `method:`,
renderizados como formulário nativo com CSRF, `danger: true` para ações
destrutivas e `avatar:` no gatilho. `ds_avatar(image:, kind:, size:)` mostra
foto ou logotipo; sem imagem, o glifo de pessoa ou de organização. `ds_tabs`
renderiza abas sublinhadas (`ui-tabs`) e `ui-nav-link` serve a barras laterais.

Inclua `components.css` e o bundle `design-system.js` pelo pipeline de assets.
O bundle executa `enhance()` uma vez. O Cloud permite scripts locais, usa nonce
no script e não permite `unsafe-inline` nem `eval`. Os componentes não leem
cookies, tokens ou credenciais e não fazem requests.

Com JavaScript, o runtime acrescenta menus, revelar senha, validação acessível,
confirmações opcionais (`confirm: {title:, message:, accept:, cancel:}`), bloqueio
de envio duplicado e restauração após voltar pelo navegador. Botões de envio
mantêm `name` e `value` no POST. Sem JavaScript, formulários, checkboxes, links e
disclosures continuam nativos. Autorização, CSRF e confirmações obrigatórias
continuam validados pelo servidor, independentemente dos diálogos opcionais.

## Identidade, galeria e manutenção

A fonte de tokens é `tokens.css`; os controles não dependem de `style.css` do
aplicativo. O produto define composição e texto base. A densidade padrão é a
compacta (controles de 32px), a mesma do desktop e das telas de aplicativo do
Cloud; `ui-comfortable` oferece controles de 44px para fluxos de toque, como
login e autorização do Mac. `--fg-3` serve a
estados inativos e decoração, não a texto essencial. A marca é `prometeu.svg`.

`npm run dev` na raiz abre o Vite. Acesse
`/packages/design-system/index.html`: a galeria usa a API do pacote para criar
todos os componentes, incluindo menus, submenus, seleção, senha e diálogo com
falha simulada. A galeria também funciona com um servidor estático depois do
build do pacote. `/design-system.html` verifica o consumo nas telas do desktop.

Mudanças começam no pacote, na galeria e nos testes. Atualize a versão antes
de distribuir: correções compatíveis incrementam patch; adições, minor;
remoções ou contratos incompatíveis, major (durante 0.x, minor). Reimporte no
Cloud e versione o manifesto junto. Rollback reverte pacote, adaptador e assets
juntos. Nenhum produto busca versões novas pela rede em runtime.

Verificações: `e2e/design-system.spec.ts`, `e2e/ui.spec.ts` e
`e2e/actions.spec.ts` no desktop; `test/helpers/design_system_components_test.rb`,
`test/design_system_test.rb` e `test/browser/accounts.spec.js` no Cloud.
