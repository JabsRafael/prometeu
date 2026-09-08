/// Rename inline by replacing the label with an input and restoring it afterward.
let open: HTMLInputElement | null = null;

/// Callers consult editing state before board updates replace a row containing an active input.
export const editing = () => open !== null;

/// Replace node with an input. Return the new name or null when unchanged; the caller owns redraws.
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

  // The input owns keyboard shortcuts. Enter or blur saves; Escape cancels, matching Finder behavior.
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") end(true);
    if (e.key === "Escape") end(false);
  });
  input.addEventListener("blur", () => end(true));
  // Input clicks must not activate the containing card.
  for (const ev of ["mousedown", "click", "dblclick"]) {
    input.addEventListener(ev, (e) => e.stopPropagation());
  }
}
