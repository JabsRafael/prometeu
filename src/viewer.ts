import { invoke } from "./ipc";
import { fromBack } from "./i18n";
import { highlight } from "./highlight";
import { fileIcon, icon } from "./icons";
import { $ } from "./util";

/// Viewer de arquivo no centro, como o editor do Conductor: migalha com o
/// caminho, gutter com número de linha, código colorido. Não há modo de
/// leitura e modo de edição — o arquivo abre pronto para escrever, e o que se
/// vê enquanto se escreve continua colorido.
///
/// O truque é uma pilha de dois: a caixa que recebe o que você digita fica
/// embaixo, com o texto transparente, e o `<pre>` colorido em cima. Você lê o
/// `<pre>` e escreve na caixa, e o `highlight` continua sendo o único dono das
/// cores do app — não entrou editor de fora para isto.

/// O arquivo na tela e o que o disco tinha quando esta edição começou. É esse
/// texto — e não o que o disco tem agora — que vai na guarda de corrida ao
/// salvar: se o agente escreveu no meio, o back recusa em vez de passar por
/// cima do que ele fez.
let shown: { id: string; path: string; text: string } | null = null;
let request = 0;

/// O que foi escrito e ainda não foi salvo, por arquivo. Sair do arquivo não
/// joga fora: o rascunho espera aqui e volta sozinho quando ele é reaberto.
/// Enquanto existe rascunho, o arquivo na tela é seu — o redesenho do quadro,
/// que chega a cada ferramenta do agente, não encosta nele. Desfazer até o
/// texto de origem apaga o rascunho, e aí a tela volta a acompanhar o disco.
type Draft = { was: string; text: string };
const drafts = new Map<string, Draft>();
const key = (id: string, path: string) => `${id}\n${path}`;

let fail: (m: string) => void = () => {};
/// Salvou: o arquivo mudou no disco sem o agente ter mexido em nada, então
/// nada mais avisaria a tela de Mudanças.
let saved: (id: string) => void = () => {};
let frame = 0;

const box = () => $("vtext") as HTMLTextAreaElement;
const here = () => (shown ? key(shown.id, shown.path) : "");
const draft = () => drafts.get(here());

export function init(onError: (m: string) => void, onSaved: (id: string) => void) {
  fail = onError;
  saved = onSaved;
  $("vcopy").innerHTML = icon("copy");
  $("vcopy").addEventListener("click", () => {
    if (!shown) return;
    navigator.clipboard.writeText(shown.path).catch((e) => fail(fromBack(e)));
  });
  $("vsave").innerHTML = icon("check");
  $("vsave").addEventListener("click", () => void save());
  $("vcancel").innerHTML = icon("x");
  $("vcancel").addEventListener("click", () => void revert());

  const text = box();
  text.addEventListener("input", typed);
  // A caixa não rola por conta própria — quem rola é o `.vcode`. Se o navegador
  // a rolar mesmo assim (para trazer o cursor de volta à tela, por exemplo), as
  // duas camadas saem do lugar uma da outra.
  text.addEventListener("scroll", () => {
    text.scrollTop = 0;
    text.scrollLeft = 0;
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void revert();
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
      typed();
    }
  });
}

/// Desenha o arquivo. Chamado de novo a cada evento do quadro enquanto o
/// viewer está aberto, então o texto acompanha o agente editando; a rolagem
/// só é mexida quando o conteúdo mudou de verdade.
export async function show(id: string, path: string) {
  const k = key(id, path);
  const same = shown?.id === id && shown.path === path;
  // Escreveu e não salvou: o que está na tela é seu, não o do disco.
  if (same && drafts.has(k)) return;

  const currentRequest = ++request;
  let text = "";
  let error = "";
  try {
    text = await invoke<string>("read_file", { id, rel: path });
  } catch (e) {
    error = fromBack(e);
  }
  if (currentRequest !== request) return;
  // A leitura demora; nesse meio-tempo a pessoa pode ter começado a escrever.
  if (shown?.id === id && shown.path === path && drafts.has(k)) return;
  if (same && shown!.text === text && !error) return;
  shown = { id, path, text };

  const cut = path.lastIndexOf("/");
  const crumb = $("vcrumb");
  crumb.innerHTML = `${fileIcon(path.slice(cut + 1), 14)}<span class="dir"></span><span class="nm"></span>`;
  crumb.children[1].textContent = cut === -1 ? "" : path.slice(0, cut + 1);
  crumb.children[2].textContent = path.slice(cut + 1);

  // Arquivo que nem abriu — binário, grande demais — não se escreve: some a
  // caixa, e o `<pre>` conta o motivo no lugar do código.
  const ta = box();
  ta.hidden = !!error;
  if (error) {
    drafts.delete(k);
    $("vgutter").textContent = "";
    $("vpre").innerHTML = `<span class="h-c"></span>`;
    $("vpre").children[0].textContent = error;
    chrome();
    return;
  }

  // Voltou para um arquivo que ficou pela metade: continua de onde parou, e a
  // guarda de corrida continua sendo a do texto de quando começou.
  const pending = drafts.get(k);
  if (pending) shown = { id, path, text: pending.was };
  const value = pending ? pending.text : text;

  // Redesenho do mesmo arquivo não pode jogar o cursor para o fim: quem está
  // com o arquivo na tela está lendo, ou prestes a escrever ali.
  const at = same ? [ta.selectionStart, ta.selectionEnd] : [0, 0];
  ta.value = value;
  if (same) ta.setSelectionRange(Math.min(at[0], value.length), Math.min(at[1], value.length));
  paint();
  chrome();
  if (!same) $("vcode").scrollTo(0, 0);
}

function typed() {
  if (!shown) return;
  const value = box().value;
  const k = here();
  const was = drafts.get(k)?.was ?? shown.text;
  // Desfez até o texto de origem: não há mais nada de seu na tela, e o arquivo
  // volta a acompanhar o disco sozinho.
  if (value === was) drafts.delete(k);
  else drafts.set(k, { was, text: value });
  chrome();
  soon();
}

/// Recolorir custa uma varredura do arquivo inteiro. Digitando rápido são
/// dezenas por segundo, e nenhuma delas seria vista: uma por quadro basta.
function soon() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(paint);
}

function paint() {
  cancelAnimationFrame(frame);
  const text = box().value;
  // A linha vazia do fim conta: dá para escrever nela.
  const rows: string[] = [];
  for (let i = 1; i <= text.split("\n").length; i++) rows.push(String(i));
  $("vgutter").textContent = rows.join("\n");
  $("vpre").innerHTML = highlight(text, shown?.path ?? "");
}

/// Salvar e desistir só aparecem quando há o que salvar ou o que desistir.
function chrome() {
  const dirty = !!draft();
  $("vsave").hidden = !dirty;
  $("vcancel").hidden = !dirty;
  $("vcrumb").classList.toggle("dirty", dirty);
}

/// Desistir joga o rascunho fora e volta ao disco — que pode não ser mais o
/// que estava na tela quando você começou a escrever.
async function revert() {
  if (!shown || !draft()) return;
  const { id, path, text } = shown;
  drafts.delete(here());
  box().value = text;
  paint();
  chrome();
  await show(id, path);
}

async function save() {
  if (!shown || !draft()) return;
  const { id, path } = shown;
  const text = box().value;
  try {
    await invoke("write_file", { id, rel: path, text, was: shown.text });
  } catch (e) {
    fail(fromBack(e));
    return;
  }
  drafts.delete(here());
  shown = { id, path, text };
  chrome();
  saved(id);
}
