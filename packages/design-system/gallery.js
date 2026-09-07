import { button, input, field, checkbox, select, password, card, badge, notice, disclosure, menuButton, formDialog, confirmDialog } from "./dist/index.js";

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
