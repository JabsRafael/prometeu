import { invoke } from "./ipc";
import { fromBack } from "./i18n";
import { highlight } from "./highlight";
import { fileIcon, icon } from "./icons";
import { $ } from "./util";

/// Viewer de arquivo no centro, como o editor do Conductor: migalha com o
/// caminho, gutter com número de linha, código colorido. O lápis abre o mesmo
/// texto numa caixa por cima: corrigir uma linha ou apagar um trecho não
/// precisa virar pedido para o agente.

let shown: { id: string; path: string; text: string } | null = null;
let request = 0;

/// O que está sendo escrito e ainda não foi para o disco, por arquivo. `was` é
/// o texto de quando a edição começou: é ele que vai na guarda de corrida do
/// back, e não o que o disco tem agora — senão salvar depois de o agente ter
/// escrito passaria por cima dele sem avisar.
///
/// Sair do arquivo não joga isso fora. O rascunho espera aqui e a edição volta
/// sozinha quando o arquivo é reaberto: clicar em outro arquivo por um segundo
/// não é motivo para perder o que foi digitado.
type Draft = { was: string; text: string };
const drafts = new Map<string, Draft>();
const key = (id: string, path: string) => `${id}\n${path}`;

let editing: string | null = null;
let fail: (m: string) => void = () => {};
/// Salvou: o arquivo mudou no disco sem o agente ter mexido em nada, então
/// nada mais avisaria a tela de Mudanças — e ela só se confere sozinha
/// enquanto você está olhando para ela.
let saved: (id: string) => void = () => {};

const box = () => $("vtext") as HTMLTextAreaElement;

export function init(onError: (m: string) => void, onSaved: (id: string) => void) {
  fail = onError;
  saved = onSaved;
  $("vcopy").innerHTML = icon("copy");
  $("vcopy").addEventListener("click", () => {
    if (!shown) return;
    navigator.clipboard.writeText(shown.path).catch((e) => fail(fromBack(e)));
  });

  $("vedit").innerHTML = icon("pencil");
  $("vedit").addEventListener("click", edit);
  $("vsave").innerHTML = icon("check");
  $("vsave").addEventListener("click", () => void save());
  $("vcancel").innerHTML = icon("x");
  $("vcancel").addEventListener("click", () => void discard());

  const text = box();
  text.addEventListener("input", () => {
    const draft = editing && drafts.get(editing);
    if (draft) draft.text = text.value;
    fit();
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void discard();
      return;
    }
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
      return;
    }
    // Tab no meio do código é recuo, não troca de foco. `insertText` é o que
    // mantém o desfazer do navegador de pé — mexer no `value` na mão apaga a
    // pilha inteira.
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
      const draft = editing && drafts.get(editing);
      if (draft) draft.text = text.value;
      fit();
    }
  });
}

/// Desenha o arquivo. Chamado de novo a cada evento do quadro enquanto o
/// viewer está aberto, então o texto acompanha o agente editando; a rolagem
/// só é mexida quando o conteúdo mudou de verdade.
export async function show(id: string, path: string) {
  const same = shown?.id === id && shown.path === path;
  // Editando este arquivo, o que está na tela é o que a pessoa escreveu, não o
  // que está no disco: redesenhar apagaria.
  if (editing === key(id, path)) return;

  const currentRequest = ++request;
  let text = "";
  let error = "";
  try {
    text = await invoke<string>("read_file", { id, rel: path });
  } catch (e) {
    error = fromBack(e);
  }
  if (currentRequest !== request) return;
  // A leitura demora; nesse meio-tempo a pessoa pode ter clicado no lápis.
  if (editing === key(id, path)) return;
  // Quem está na tela agora é outro arquivo: a edição sai da tela — e só da
  // tela, o rascunho continua guardado esperando este arquivo voltar. Sem
  // isto, salvar escreveria o texto de um arquivo dentro do outro.
  if (editing) {
    editing = null;
    mode();
  }
  if (same && shown!.text === text && !error) return;
  shown = { id, path, text };

  const cut = path.lastIndexOf("/");
  const crumb = $("vcrumb");
  crumb.innerHTML = `${fileIcon(path.slice(cut + 1), 14)}<span class="dir"></span><span class="nm"></span>`;
  crumb.children[1].textContent = cut === -1 ? "" : path.slice(0, cut + 1);
  crumb.children[2].textContent = path.slice(cut + 1);

  // Arquivo que nem abriu — binário, grande demais — não se edita.
  $("vedit").hidden = !!error;
  paint(error);
  if (!same) $("vcode").scrollTo(0, 0);

  // Voltou para um arquivo que ficou pela metade: a edição continua de onde
  // parou, com o texto de origem que ela tinha.
  const draft = drafts.get(key(id, path));
  if (draft && !error) resume(id, path, draft);
}

function paint(error = "") {
  const pre = $("vpre");
  if (error) {
    $("vgutter").textContent = "";
    pre.innerHTML = `<span class="h-c"></span>`;
    pre.children[0].textContent = error;
    return;
  }
  const text = shown?.text ?? "";
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  gutter(lines.length);
  pre.innerHTML = highlight(text, shown?.path ?? "");
}

function gutter(count: number) {
  const rows: string[] = [];
  for (let i = 1; i <= count; i++) rows.push(String(i));
  $("vgutter").textContent = rows.join("\n");
}

function edit() {
  if (!shown || editing) return;
  const draft = { was: shown.text, text: shown.text };
  drafts.set(key(shown.id, shown.path), draft);
  resume(shown.id, shown.path, draft);
}

function resume(id: string, path: string, draft: Draft) {
  editing = key(id, path);
  // O que o back vai comparar com o disco na hora de salvar é o texto de
  // quando a edição começou, não o que chegou depois.
  shown = { id, path, text: draft.was };
  mode();
  box().value = draft.text;
  fit();
  box().focus();
}

/// Desistir joga o rascunho fora e volta a mostrar o que o disco tem agora —
/// que pode não ser mais o que estava na tela quando a edição começou.
async function discard() {
  if (!shown || !editing) return;
  const { id, path } = shown;
  drafts.delete(editing);
  editing = null;
  mode();
  await show(id, path);
}

function mode() {
  $("vpre").hidden = !!editing;
  $("vtext").hidden = !editing;
  $("vedit").hidden = !!editing;
  $("vsave").hidden = !editing;
  $("vcancel").hidden = !editing;
}

/// A caixa cresce com o texto em vez de rolar por dentro: quem rola é o
/// `vcode`, o mesmo que rolava na leitura, e assim o gutter continua ao lado
/// das linhas certas. A linha vazia do fim conta — dá para escrever nela.
function fit() {
  const text = box();
  text.style.height = "0px";
  text.style.height = `${text.scrollHeight}px`;
  gutter(text.value.split("\n").length);
}

async function save() {
  if (!shown || !editing) return;
  const text = box().value;
  try {
    await invoke("write_file", { id: shown.id, rel: shown.path, text, was: shown.text });
  } catch (e) {
    fail(fromBack(e));
    return;
  }
  drafts.delete(editing);
  editing = null;
  shown = { ...shown, text };
  mode();
  paint();
  saved(shown.id);
}
