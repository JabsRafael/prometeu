import { avatar, button, input, field, checkbox, select, password, card, badge, notice, disclosure, menuButton, formDialog, confirmDialog, searchablePicker } from "./dist/index.js";

const examples = document.querySelector("#examples");
const output = notice("Interaja com os componentes para ver seus estados.");
const row = (...children) => {
  const root = document.createElement("div"); root.className = "ui-actions";
  root.append(...children); return root;
};
const disabled = button("Indisponível"); disabled.disabled = true;
const pending = button("Salvando…", undefined, "pri"); pending.disabled = true; pending.setAttribute("aria-busy", "true");
examples.append(card("03 / Ações",
  row(button("Salvar", () => { output.textContent = "Alterações salvas."; }, "pri"), button("Cancelar"), button("Editar", undefined, "ghost")),
  row(button("Excluir conta", async () => {
    output.textContent = await confirmDialog({ title: "Excluir conta?", message: "Demonstração: nenhum dado será excluído.", accept: "Excluir", cancel: "Cancelar" }) ? "Exclusão confirmada na demonstração." : "Exclusão cancelada.";
  }, "danger"), disabled, pending)));

const name = input(); name.name = "name"; name.autocomplete = "name"; name.required = true;
const email = input("email-inválido"); email.type = "email"; email.setAttribute("aria-invalid", "true");
const invalid = field("Email", email, "Informe um email válido."); invalid.querySelector(".ui-hint").classList.add("ui-error");
const project = select("cloud", [["cloud", "Prometeu Cloud"], ["desktop", "Prometeu Desktop"]]);
project.onchange = () => { output.textContent = `Projeto selecionado: ${project.value}.`; };
const unavailable = input("Indisponível"); unavailable.disabled = true;
const secret = password("", { show: "Mostrar senha", hide: "Ocultar senha" });
examples.append(card("04 / Formulário", field("Nome", name), invalid, field("Projeto", project.control),
  field("Senha", secret.root), field("Campo desabilitado", unavailable), checkbox("Manter as configurações deste projeto.", true).label));

const details = document.createElement("p"); details.className = "ui-hint";
details.textContent = "Disclosure nativo: abre com Enter ou Espaço.";
examples.append(card("05 / Feedback", output, notice("Não foi possível salvar. Seus dados continuam no formulário.", "error"),
  notice("Confira o código antes de autorizar seu Mac.", "warning"), row(badge("Desktop"), badge("Esta sessão", true)),
  disclosure("Informações adicionais", details)));

examples.append(card("06 / Menus e diálogos", menuButton("Ações do projeto", () => [
  { label: "Renomear", run: () => { output.textContent = "Renomear selecionado."; } },
  { label: "Indisponível", disabled: true },
  { label: "Exportar", sub: [{ label: "Copiar", run: () => { output.textContent = "Copiar selecionado."; } }] },
  "sep",
  { label: "Excluir", danger: true, run: () => { output.textContent = "Excluir selecionado."; } },
]), button("Editar perfil", () => {
  const name = input(); name.required = true;
  const simulate = checkbox("Simular erro ao salvar", false);
  const project = select("cloud", [["cloud", "Prometeu Cloud"], ["desktop", "Prometeu Desktop"]]);
  const dialog = formDialog({
    title: "Editar perfil", save: "Salvar", cancel: "Cancelar", error: cause => cause.message,
    submit: async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
      if (simulate.control.checked) throw new Error("Não foi possível salvar. Tente novamente.");
      output.textContent = `Perfil salvo: ${name.value}.`;
    },
  });
  dialog.body.append(field("Nome do perfil", name), field("Projeto", project.control), simulate.label);
  dialog.open();
})));

// Navigation uses the same underlined tabs and sidebar links emitted by the Rails adapter.
const tabs = document.createElement("nav"); tabs.className = "ui-tabs"; tabs.setAttribute("aria-label", "Catálogo");
const sidebar = document.createElement("nav"); sidebar.className = "ui-stack"; sidebar.style.gap = "2px"; sidebar.style.maxWidth = "220px";
for (const [list, labels, current] of [[tabs, ["MCPs", "Plugins", "Skills"], "MCPs"], [sidebar, ["Perfil", "Segurança", "Sessões"], "Segurança"]]) {
  for (const label of labels) {
    const link = document.createElement("a"); link.href = "#"; link.textContent = label;
    if (list === sidebar) link.className = "ui-nav-link";
    if (label === current) link.setAttribute("aria-current", "page");
    link.addEventListener("click", event => { event.preventDefault(); output.textContent = `${label} selecionado.`; });
    list.append(link);
  }
}
const identity = row(avatar(), avatar(undefined, "person", "md"), avatar(undefined, "organization", "md"), avatar(undefined, "organization", "lg"));
const account = menuButton("Gustavo", () => [{ label: "Configurações" }, "sep", { label: "Sair", danger: true }]);
account.prepend(avatar());
examples.append(card("07 / Navegação", tabs, sidebar, identity, row(account)));

// Delivery stays local in the gallery; production hosts provide their own transport.
const { feedbackWidget } = await import("./dist/index.js");
feedbackWidget({
  labels: {
    trigger: "Feedback", title: "Deixe seu feedback", kind: "Tipo", problem: "Problema", idea: "Ideia", other: "Outro",
    description: "Descrição", attach: "Anexar imagem", capture: "Capturar tela", remove: "Remover imagem",
    send: "Enviar feedback privado", close: "Fechar", privacy: "Demonstração local: nenhum dado será enviado.",
    publicReport: "Reportar bug publicamente", publicReportHint: "Abre uma issue pública no GitHub sem enviar dados automaticamente.",
    invalidImage: "Use PNG, JPEG ou WebP de até 5 MB.", empty: "Escreva seu feedback.", success: "Feedback recebido na demonstração.",
  },
  publicIssue: "https://github.com/prometeucorp/prometeu/issues/new",
  submit: async () => {}, error: cause => String(cause),
});


function pickerExample() {
  const selected = notice("Nenhuma opção escolhida");
  const starred = new Set();
  let picker;
  const items = () => Array.from({ length: 100 }, (_, n) => ({
    key: String(n), label: `Opção ${String(n).padStart(3, "0")}`,
    detail: n === 0 ? "Descrição com acentuação · Café · Codex" : `Detalhe ${n}`,
    group: n < 5 ? "Recentes" : "Todas as opções", checked: n === 2, disabled: n === 98,
    secondary: { label: `${starred.has(n) ? "Desfavoritar" : "Favoritar"} Opção ${String(n).padStart(3, "0")}`,
      pressed: starred.has(n), run: () => {
        if (starred.has(n)) starred.delete(n); else starred.add(n);
        picker.update(items());
      } },
  }));
  const trigger = button("Buscar opção", () => {
    picker = searchablePicker(trigger, {
      label: "Opções disponíveis", searchPlaceholder: "Buscar opções", empty: "Nenhuma opção encontrada",
      items: items(), select: key => { selected.textContent = `Escolhida: Opção ${String(key).padStart(3, "0")}`; },
      refresh: { label: "Atualizar opções", run: () => picker.update(items(), "Catálogo atualizado") },
      additional: { label: "Mostrar opções adicionais", checked: false,
        change: checked => picker.update(checked ? [...items(), { key: "extra", label: "Opção adicional" }] : items()) },
    });
  });
  return [trigger, selected];
}
examples.append(card("Busca em listas extensas", ...pickerExample(), button("Busca em diálogo", () => {
  const dialog = formDialog({ title: "Exemplo de busca", save: "Salvar", cancel: "Cancelar", submit: async () => {}, error: String });
  dialog.body.append(...pickerExample()); dialog.open();
})));
