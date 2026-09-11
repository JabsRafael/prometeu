import inspectorSource from "./browser-inspector.js?raw";
import type { BrowserInspection, BrowserRect, BrowserSelection } from "./browser-types";

type InspectorWindow = Window & {
  eval(source: string): unknown;
  __prometeuInspector?: {
    enabled: boolean;
    setEnabled(enabled: boolean): void;
    takeSelection(): BrowserSelection | null;
    selectionCurrent(): boolean;
    dispose(): void;
  };
};
type Preview = {
  frame: HTMLIFrameElement;
  port: number;
  history: string[];
  index: number;
  ready: Promise<void>;
  settle(): void;
  navigated(url: string): void;
};
const previews = new Map<string, Preview>();
let captures = 0;

// Sample product content is fixture data. Only this browser mock creates an iframe.
const demo = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; } body { margin: 0; color: #252820; background: #f8f7f2; font: 15px/1.5 system-ui, sans-serif; }
  header, main { padding: 24px; } header { display: flex; justify-content: space-between; border-bottom: 1px solid #dddcd2; }
  a { color: inherit; } h1 { max-width: 14ch; font-size: clamp(28px, 6vw, 48px); line-height: 1.08; letter-spacing: -.04em; }
  .sample { height: 130px; margin: 24px 0; border-radius: 16px; background: radial-gradient(circle at 65% 45%, #e5bb78 0 40px, transparent 41px), #dfe5cf; }
  button { padding: 12px 20px; border: 0; border-radius: 24px; background: #303d28; color: white; font: inherit; cursor: pointer; }
  label { display: grid; gap: 6px; margin-top: 20px; } input { min-width: 0; width: 100%; padding: 10px; border: 1px solid #c7ccbd; border-radius: 8px; font: inherit; }
  output { display: block; margin-top: 8px; } small { overflow-wrap: anywhere; color: #626857; }
</style></head><body>
  <header><strong>Forma</strong><a id="design-link" href="/colecao">Ver coleção</a></header>
  <main id="design-card"><small id="design-location"></small>
    <h1>Espaço para suas próximas ideias.</h1>
    <p>Objetos, cores e referências para criar com mais intenção.</p>
    <div class="sample" role="img" aria-label="Composição verde com um círculo dourado"></div>
    <button id="design-button" type="button">Adicionar ao projeto</button>
    <output id="design-status" aria-live="polite"></output>
    <form><label>Nome do projeto<input id="design-name" placeholder="Meu próximo projeto"></label>
      <label>Enviar referência<input id="design-upload" type="file" accept="image/*"></label>
      <output id="upload-status" aria-live="polite"></output>
    </form>
  </main>
</body></html>`;

const page = (preview: Preview) => preview.frame.contentWindow as InspectorWindow;
const currentUrl = (preview: Preview) => preview.history[preview.index];

function render(id: string, preview: Preview) {
  // Wake an interrupted inspection so it can wait for the replacement document instead.
  preview.settle();
  preview.ready = new Promise<void>((resolve, reject) => {
    preview.settle = resolve;
    preview.frame.onload = () => {
      try {
        const content = page(preview);
        const document = content.document;
        content.eval(inspectorSource);
        document.getElementById("design-location")!.textContent = currentUrl(preview);
        document.getElementById("design-button")!.addEventListener("click", () => {
          document.getElementById("design-status")!.textContent = "Referência adicionada ao projeto.";
        });
        document.getElementById("design-upload")!.addEventListener("change", event => {
          document.getElementById("upload-status")!.textContent = (event.target as HTMLInputElement).files?.[0]?.name ?? "";
        });
        document.querySelector("form")!.addEventListener("submit", event => event.preventDefault());
        document.addEventListener("click", event => {
          const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
          if (!anchor) return;
          event.preventDefault();
          navigate(id, new URL(anchor.getAttribute("href")!, currentUrl(preview)).href);
        });
        resolve();
      } catch (error) { reject(error); }
    };
    preview.frame.srcdoc = demo;
  });
  preview.navigated(currentUrl(preview));
}

async function ready(id: string) {
  const preview = previews.get(id);
  if (!preview) throw 'i18n:{"code":"err.browser.inspectFailed"}';
  let loading;
  do {
    loading = preview.ready;
    await loading;
  } while (loading !== preview.ready);
  if (previews.get(id) !== preview) throw 'i18n:{"code":"err.browser.inspectFailed"}';
  return preview;
}

export function open(id: string, port: number, navigated: (url: string) => void) {
  let preview = previews.get(id);
  if (!preview) {
    const frame = document.createElement("iframe");
    frame.dataset.browserWorkspace = id;
    frame.title = "Forma — projeto de exemplo";
    frame.style.cssText = "display:block;width:100%;height:100%;border:0";
    preview = { frame, port, history: [`http://localhost:${port}/`], index: 0, ready: Promise.resolve(), settle() {}, navigated };
    previews.set(id, preview);
    render(id, preview);
    document.getElementById("webbody")!.append(frame);
  }
  for (const [workspace, entry] of previews) entry.frame.hidden = workspace !== id;
  return preview.port;
}

export function url(id: string) { return previews.has(id) ? currentUrl(previews.get(id)!) : null; }

export function navigate(id: string, address: string) {
  let parsed: URL;
  try {
    parsed = new URL(address);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    throw `i18n:${JSON.stringify({ code: "err.browser.badUrl", args: { url: address } })}`;
  }
  const preview = previews.get(id);
  if (!preview) return;
  preview.history.splice(preview.index + 1);
  preview.history.push(parsed.href);
  preview.index++;
  render(id, preview);
}

export function back(id: string) {
  const preview = previews.get(id);
  if (!preview || preview.index === 0) return;
  preview.index--;
  render(id, preview);
}

export function forward(id: string) {
  const preview = previews.get(id);
  if (!preview || preview.index === preview.history.length - 1) return;
  preview.index++;
  render(id, preview);
}

export function reload(id: string) {
  const preview = previews.get(id);
  if (preview) render(id, preview);
}

export function bounds(id: string, width: number, height: number) {
  const preview = previews.get(id);
  // The DOM owns position; native coordinates must not offset the iframe within its container.
  if (preview) preview.frame.hidden = width <= 0 || height <= 0;
}

export function hide(id: string) {
  const preview = previews.get(id);
  if (preview) preview.frame.hidden = true;
}

export function close(id: string) {
  const preview = previews.get(id);
  if (!preview) return;
  page(preview)?.__prometeuInspector?.dispose();
  preview.settle();
  preview.frame.remove();
  previews.delete(id);
}

export async function inspect(id: string, enabled: boolean) {
  const preview = await ready(id);
  page(preview).__prometeuInspector!.setEnabled(enabled);
}

export async function selection(id: string): Promise<BrowserInspection> {
  const preview = await ready(id);
  const inspector = page(preview).__prometeuInspector!;
  const selected = inspector.takeSelection();
  return { active: inspector.enabled, selection: selected ? { ...selected, url: currentUrl(preview) } : null };
}

// The browser fixture has no native snapshot or filesystem. This only exercises attachment wiring.
export async function capture(id: string, rect?: BrowserRect) {
  const preview = await ready(id);
  if (rect && !page(preview).__prometeuInspector?.selectionCurrent()) throw 'i18n:{"code":"err.browser.captureFailed"}';
  return `/tmp/browser-${id.replace(/[^a-z0-9_-]/gi, "-")}-${++captures}.png`;
}
