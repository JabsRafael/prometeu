import type { BrowserSelection } from "./browser-types";

export type BrowserContext = { selection: BrowserSelection; image?: string };

const OPEN = '<prometeu-browser-element v="1">';
const CLOSE = '</prometeu-browser-element>';
const utf8 = new TextEncoder();

export function encodeBrowserContext(context: BrowserContext): string {
  const json = JSON.stringify(context).replace(/</g, "\\u003c");
  const image = context.image === undefined ? "" : `@${JSON.stringify(context.image)}`;
  return `${OPEN}\n${json}\n${image}\n${CLOSE}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function string(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && utf8.encode(value).length <= limit;
}

function dimension(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000 && (!positive || value > 0);
}

function validSelection(value: unknown): value is BrowserSelection {
  if (!record(value) || !keys(value, ["url", "selector", "tag", "text", "html", "styles", "rect", "viewport"])) return false;
  if (!string(value.url, 16_384) || !string(value.selector, 4096) || !value.selector
    || !string(value.tag, 128) || !/^[a-zA-Z0-9-]+$/.test(value.tag)
    || !string(value.text, 8192) || !string(value.html, 49_152)) return false;
  try {
    if (!["http:", "https:"].includes(new URL(value.url).protocol)) return false;
  } catch { return false; }
  if (!record(value.styles) || Object.keys(value.styles).length > 64
    || !Object.entries(value.styles).every(([key, style]) => string(key, 128) && key.length > 0 && string(style, 4096))) return false;
  const rect = value.rect;
  const viewport = value.viewport;
  return record(rect) && keys(rect, ["x", "y", "width", "height"])
    && dimension(rect.x) && dimension(rect.y) && dimension(rect.width, true) && dimension(rect.height, true)
    && record(viewport) && keys(viewport, ["width", "height"])
    && dimension(viewport.width, true) && dimension(viewport.height, true)
    && utf8.encode(JSON.stringify({ active: false, selection: value })).length <= 256 * 1024;
}

function decode(block: string): BrowserContext | null {
  // Escaping '<' can expand an otherwise bounded snapshot sixfold.
  if (block.length > 2 * 1024 * 1024) return null;
  const lines = block.split("\n");
  if (lines.length !== 4 || lines[0] !== OPEN || lines[3] !== CLOSE) return null;
  try {
    const value: unknown = JSON.parse(lines[1]);
    if (!record(value) || !keys(value, ["selection", "image"]) || !validSelection(value.selection)) return null;
    if ("image" in value && (!string(value.image, 4096)
      || !/^(?:\/(?!\/)|[a-zA-Z]:[\\/])/.test(value.image)
      || !/\.png$/i.test(value.image) || /[\u0000\r\n]/.test(value.image))) return null;
    if (lines[2] !== (value.image === undefined ? "" : `@${JSON.stringify(value.image)}`)) return null;
    return value as BrowserContext;
  } catch { return null; }
}

/** Parse only complete blocks on their own lines; keep every other byte as ordinary user text. */
export function splitBrowserContexts(text: string): Array<string | BrowserContext> {
  const parts: Array<string | BrowserContext> = [];
  const markers = /^<prometeu-browser-element(?=[\s>]).*$|^<\/prometeu-browser-element>$/gm;
  let preserved = 0;
  let start = 0;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = markers.exec(text))) {
    if (match[0] !== CLOSE) {
      if (depth === 0) start = match.index;
      depth++;
      continue;
    }
    if (depth === 0 || --depth > 0) continue;
    const context = decode(text.slice(start, markers.lastIndex));
    if (!context) continue;
    if (start > preserved) parts.push(text.slice(preserved, start));
    parts.push(context);
    preserved = markers.lastIndex;
  }
  if (preserved < text.length || parts.length === 0) parts.push(text.slice(preserved));
  return parts;
}
