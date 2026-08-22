/// Renomear no lugar: o rótulo sai, o campo entra, e ao fim o rótulo volta.
/// Não tem diálogo porque um nome é uma linha, e o lugar dela é onde ela já está.
let open: HTMLInputElement | null = null;

/// O quadro é redesenhado a cada ferramenta que o agente usa. Quem desenha
/// pergunta aqui antes de refazer a linha debaixo de um campo aberto.
export const editing = () => open !== null;

/// `node` sai da tela e o campo entra no lugar dele. `done` recebe o nome novo,
/// ou `null` quando nada mudou — quem chamou é que sabe redesenhar.
export function start(
  node: HTMLElement,
  value: string,
  done: (title: string | null) => void,
  kind = "",
) {
  const input = document.createElement("input");
  input.className = `rename ${kind}`.trim();
  input.value = value;
  input.spellcheck = false;
  node.replaceWith(input);
  open = input;
  input.focus();
  input.select();

  const end = (save: boolean) => {
    if (open !== input) return;
    open = null;
    const title = input.value.trim();
    input.replaceWith(node);
    done(save && title && title !== value ? title : null);
  };

  // Enquanto está aberto, o teclado é do campo: ⌘W e Esc são dele, não do app.
  // Enter grava, Esc desiste, sair do campo grava — o rename do Finder.
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") end(true);
    if (e.key === "Escape") end(false);
  });
  input.addEventListener("blur", () => end(true));
  // Clicar dentro do campo é clicar no campo, não no card que o contém.
  for (const ev of ["mousedown", "click", "dblclick"]) {
    input.addEventListener(ev, (e) => e.stopPropagation());
  }
}
