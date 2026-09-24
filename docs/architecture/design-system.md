# Prometeu Design System

Status: shared executable components; decision in
[ADR 0017](../decisions/0017-executable-design-system.md). The package contains
rendering, behavior, styles and Rails adaptation.

## Source of truth

- [`packages/design-system`](../../packages/design-system/README.md): the
  `@prometeu/design-system` package, canonical source of colors, fonts, radii,
  spacing, DOM controls, menus, dialogs, icons, styles and the Rails adapter.
  Token names and values are preserved. The package documents APIs, imports,
  lifecycle and accessibility contracts.
- [`src/ui-tokens.css`](../../src/ui-tokens.css): imports the tokens and keeps
  only the geometry and states exclusive to the desktop.
- [`src/ui.css`](../../src/ui.css): imports the shared components and adapts
  only legacy controls to the desktop. `style.css` imports that base; the
  screens' composition styles stay in the screens.
- [`src/ui.ts`](../../src/ui.ts): re-exports the package's components, with no
  local implementation of `button`, `input`, `field`, `checkbox`, `select`,
  `dropdown`, `disclosure` or `formDialog`.
- [`src/menu.ts`](../../src/menu.ts) and [`src/icons.ts`](../../src/icons.ts):
  re-export the package's generic menus and icons. Icons for stages, files and
  providers stay in the desktop's presentation adapter.

Components receive already-translated text and callbacks. They do not import
IPC, persisted state, the agent catalog or business rules. A screen composes
these primitives and keeps its own domain validations.

## Usage and accessibility

`field(label, control, help)` associates the name and description with the
control. `input` keeps the native `required`, `pattern`, `min` and `max`. Use
`aria-invalid="true"` and associated error text when domain validation fails.
`checkbox` keeps the native input inside the label, with a size independent of
text fields; long labels wrap next to the control.

`toggle` reuses the native checkbox with switch semantics. `radio` keeps native
radio-group keyboard behavior. Both appear in the standalone galleries and the
notification preferences; `e2e/notifications.spec.ts` covers keyboard use.

`select` returns `control`, `value`, `onchange` and `setOptions`. The selector
uses the same `dropdown` extracted from the launcher and the shared menu. The
model selection updates its options without creating another component. A
required selection uses `root` and the `name`/`required` attributes when the
consumer depends on native submission. The `native` field takes part in
`FormData` and in HTML validation. Legacy screens that use only `control` and
send their own commands still validate the domain rules before saving.
Opening a dropdown focuses its menu options. Arrow keys move actual focus,
not only the visual selection, and closing restores focus to the trigger.

`formDialog` uses `dialog.showModal()`: content behind it becomes inert, focus
returns on close and Tab/Shift+Tab cycle within the form. The body scrolls and
the footer stays visible. Saving respects HTML validation, prevents double
submission, signals `aria-busy` and presents failures in `role="alert"` without
losing the typed text. Menus opened in the dialog join the same layer. Escape
closes the menu first; another Escape closes the dialog. Global shortcuts do
not change the workspace while the dialog is open. While submission is pending,
Escape and cancellation leave the dialog open so progress and failures remain
visible.

Shared dialogs use consistent header/body spacing, content-sized buttons and
grouped footer actions. Text-entry forms focus their first field; dialogs that
start with actions or selection focus the title so no button appears selected
on opening. Tab still reaches the controls with a visible focus indicator, and
Shift+Tab from the title reaches the last enabled control. The standalone
gallery's confirmation demonstrates this initial state; tests cover it in
`e2e/design-system.spec.ts` and the Projects flow in `e2e/projects.spec.ts`.
An opener replaced during a background refresh keeps focus restoration through
its stable `id` or `data-focus` key.

## Adoption

The command and agent editors in Actions use the shared fields, selectors,
checkboxes, disclosures and dialog. The launcher composes shared fields,
buttons, text input and checkboxes into a task/repository column and an
agent/tools column. Narrow windows stack the columns in a scrolling body;
the branch summary and creation actions remain in a separate, visible footer.
Model search, favorites and native effort selection use the existing pickers. The optional starting skill shares the prompt's attachment row as a ghost
button and opens the launcher's searchable picker.
Account identities wrap instead of truncating; account popovers share one row
for adding and managing accounts, and the account dialog keeps its footer
visible while its cards scroll. The optional missing-context review adds a ghost action to the launcher footer
and a panel under the prompt built from shared buttons and notices; its
Settings row uses the shared password field and switch. Launcher layout and account-dialog focus are covered in
[`e2e/launcher-layout.spec.ts`](../../e2e/launcher-layout.spec.ts), including
the English UI at representative viewport sizes, with selected WebKit checks. Text
fields in the MCP and plugin hubs use `input` and `field`, including the plugin
creation request. Worktree cleanup also uses `formDialog`,
including its busy-state cancellation guard and shared checkboxes. Their
application callbacks own progress labels and operation results. Legacy modals
in the hubs keep the previous lifecycle.

Browser mock screenshots: [workspace](../images/ui/workspace.png),
[narrow workspace](../images/ui/workspace-narrow.png),
[account popover](../images/ui/accounts.png),
[account selector](../images/ui/account-dialog.png),
[model picker](../images/ui/model-picker.png), and
[Projects dialog](../images/ui/projects-dialog.png).

New controls and changes to existing controls must reuse this base. If behavior
is missing, add it to the corresponding primitive and show the state in the
gallery. Do not copy CSS from one screen to another, and do not introduce a
component for a composition that exists on a single screen.

## Settings composition

`src/settings.ts` groups preferences into General, Agents, Resources, Actions,
and Work and team. Navigation keeps the compact, neutral sidebar; settings
search sits in the content header. `src/settings.css` owns only this screen's layout; buttons,
inputs, selectors, disclosures and menus reuse the shared primitives. The
resource library composes the existing MCP, plugin, skill and organization
catalog rows, preserving their callbacks, validation and busy state. Item
operations live in an overflow menu; the Add resource menu retains all existing
creation and import paths. A registered resource is not automatically enabled.

General keeps the notification master switch and native permission warning
visible while its details expand in place. Agents shows defaults followed by
compact account cards; quota disclosures do not change the account picker's
existing presentation. Account notices, login progress and selection remain
visible. Search and resource filters do not persist business state.

Background updates preserve the search value, focus, expanded disclosures and
scroll position. Menus for an old resource snapshot close before replacement.
`src/settings-navigation.test.ts` covers matching and legacy page destinations.
`e2e/settings.spec.ts` exercises focus restoration and disclosure geometry in
Chromium and WebKit: browser DOM replacement can lose keyboard focus or clamp
scroll before a disclosure reopens, which pure matching tests cannot prove.
Existing accounts, Cloud catalog, MCP, notifications, projects and organization
scenarios continue to cover their production paths through the grouped UI.

## Gallery and verification

`/packages/design-system/index.html` is the company's standalone gallery: it
renders components through the package's compiled API, without the app's styles
or JavaScript. It shows menu, keyboard submenu, password, selection and an
asynchronous dialog with a simulated failure. The Cloud consumes the runtime,
styles and Ruby adapter in `vendor/design-system`, imported by
`bin/design-system` and verified by SHA-256 in CI. Its views use `ds_form_with`,
`form.field`, `form.button` and the package's helpers, which keep the markup out
of the screens.
The desktop and the Cloud's application screens use the default compact
density; `ui-comfortable` (44px) is reserved for the Cloud's touch flows, such
as login and Mac authorization. Changes start in the package and reach the Cloud
through a new import, never by editing the vendored files.

Run `npm run dev` and open `/design-system.html` on the same port. The gallery
is also an entry point of the web build and does not start the backend or
agents. It shows tokens, buttons, fields, selection, error, disabled, checkbox,
menu with tag, disclosure and a form with a simulated success or failure.

[`e2e/design-system.spec.ts`](../../e2e/design-system.spec.ts) covers keyboard,
focus, validation, recoverable failure and a narrow viewport in the standalone
consumer.
[`e2e/actions.spec.ts`](../../e2e/actions.spec.ts) covers the primitives in the
feature's real flows. The architectural check prevents `ui.ts`
from depending on domain modules and prevents Actions from recreating native
selectors. The existing web and E2E tests protect the launcher, menus and hubs
during adoption.

## Searchable selection

`searchablePicker` composes through the shared menu lifetime and can open inside
an existing modal. It accepts translated labels, stable item keys, groups,
details, optional secondary actions, status text, refresh and a filter checkbox.
It does not own domain catalogs or persistence. Its update method preserves the
query, scroll and focused action; the model picker subscribes to catalog changes
and supplies updated entries. With a `search` callback the caller ranks each
query itself; Command-P quick open passes the backend's fuzzy `find_paths`
results through unchanged. Model favorites are secondary buttons, never
nested interactive content inside a selectable button. Rows grow with wrapped
model names and descriptions; square favorite buttons keep their focus indicator
inside the scroll area. `e2e/model-picker.spec.ts` covers these bounds in the
desktop composition, including narrow windows.

The search input receives focus on open. Arrow keys move among enabled choices;
Tab reaches the current choice, its secondary action and footer controls without
requiring traversal of the whole catalog. Escape closes the picker before the
parent dialog and restores trigger focus. Both standalone gallery and
`e2e/search-picker.spec.ts` cover a 100-entry list, accent-insensitive filtering,
keyboard and pointer selection, focus order and narrow dialogs in Chromium and
WebKit. The gallery also demonstrates independent star actions and dynamic updates.
