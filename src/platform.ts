/// Presentation only: macOS keeps its glyphs, app names and title bar; other systems get neutral text and a native frame.
const agent = typeof navigator === "undefined" ? "Macintosh" : navigator.userAgent;

export const mac = /Mac/.test(agent);

/// Android also reports Linux.
export const linux = /Linux/.test(agent) && !/Android/.test(agent);

const NAMES: Record<string, string> = { "⌘": "Ctrl", "⇧": "Shift", "⌥": "Alt" };

/// ⌘⇧D becomes Ctrl+Shift+D outside macOS; a glyph before a space names the key alone.
export function keys(text: string, onMac = mac): string {
  if (onMac) return text;
  return text.replace(/([⌘⇧⌥])(\s?)/g, (_, glyph: string, space: string) => NAMES[glyph] + (space ? space : "+"));
}

/// "this Mac" becomes "this computer"; "computador" keeps the masculine articles of "Mac".
export function machine(text: string, computer: string, onMac = mac): string {
  if (onMac) return text;
  return text.replace(/\bMac\b/g, (_, offset: number) => (offset === 0 ? computer[0].toUpperCase() + computer.slice(1) : computer));
}
