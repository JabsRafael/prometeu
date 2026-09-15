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

## Adoption

The command and agent editors in Actions use the shared fields, selectors,
checkboxes, disclosures and dialog. The launcher uses the same dropdown; text
fields in the MCP and plugin hubs use `input` and `field`, including the plugin
creation request. Worktree cleanup also uses `formDialog`,
including its busy-state cancellation guard and shared checkboxes. Their
application callbacks own progress labels and operation results. Legacy modals
in the hubs keep the previous lifecycle.

New controls and changes to existing controls must reuse this base. If behavior
is missing, add it to the corresponding primitive and show the state in the
gallery. Do not copy CSS from one screen to another, and do not introduce a
component for a composition that exists on a single screen.

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

[`e2e/ui.spec.ts`](../../e2e/ui.spec.ts) covers keyboard, focus, validation,
recoverable failure and a narrow viewport in Chromium and WebKit.
[`e2e/actions.spec.ts`](../../e2e/actions.spec.ts) covers the primitives in the
feature's real flows on both engines. The architectural check prevents `ui.ts`
from depending on domain modules and prevents Actions from recreating native
selectors. The existing web and E2E tests protect the launcher, menus and hubs
during adoption.
