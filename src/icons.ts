/// Ícones Lucide desenhados inline: sem fonte de ícone, sem pacote. Cada um é
/// só o miolo do <svg>; tamanho e cor vêm do CSS (`currentColor`).
const PATHS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "panel-left": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  "panel-right": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  kanban:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  "folder-open":
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  "folder-plus":
    '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  square: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  "external-link":
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  copy:
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  "list-tree":
    '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  flame:
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
};

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16): string {
  return (
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    PATHS[name] +
    "</svg>"
  );
}

/// Quadradinho com a inicial, cor estável por nome — o "N" roxo do Conductor.
const HUES = ["#6525c9", "#c9552a", "#2a7fc9", "#2a9d6e", "#c9a02a", "#c92a6a"];
export function avatar(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const el = document.createElement("span");
  el.className = "avatar";
  el.style.background = HUES[h % HUES.length];
  el.textContent = (name.trim()[0] ?? "?").toUpperCase();
  return el.outerHTML;
}

/* ---------- ícones por tipo de arquivo ---------- */

/// Os ícones coloridos da árvore do Conductor (tema Material): gem vermelha
/// para Ruby, baleia para Docker, losango laranja para git… Cada um é um
/// desenho mínimo que lê bem em 16px; o que não tem dono cai no `file` cinza.
const S = 'stroke-linecap="round" stroke-linejoin="round" fill="none"';
const badge = (bg: string, fg: string, text: string) =>
  `<rect x="2" y="2" width="20" height="20" rx="4" fill="${bg}"/>` +
  `<text x="12" y="16.5" text-anchor="middle" font-family="var(--font)" font-size="10" font-weight="700" fill="${fg}">${text}</text>`;

const FILE_ICONS: Record<string, string> = {
  ruby:
    '<path d="M7 3h10l4 6-9 12L3 9z" fill="#d63d38"/>' +
    `<path d="M3 9h18M7 3l5 6 5-6M12 9v12" stroke="#fff" stroke-opacity=".4" stroke-width="1.2" ${S}/>`,
  yaml:
    '<text x="12" y="11.5" text-anchor="middle" font-family="var(--font)" font-size="11" font-weight="900" letter-spacing="-.5" fill="#d63d38">YA</text>' +
    '<text x="12" y="22" text-anchor="middle" font-family="var(--font)" font-size="11" font-weight="900" letter-spacing="-.5" fill="#d63d38">ML</text>',
  md:
    '<rect x="1.5" y="5" width="21" height="14" rx="2" fill="#a4a09d"/>' +
    '<text x="8" y="16.2" text-anchor="middle" font-family="var(--font)" font-size="10" font-weight="800" fill="#141110">M</text>' +
    `<path d="M16.5 9v6m-2.5-2.5 2.5 2.5 2.5-2.5" stroke="#141110" stroke-width="1.8" ${S}/>`,
  docker:
    '<path d="M2 12.5h18.5c.5 0 1.5-.3 2-.8-.8-1.3-2.3-1.2-3-.9-.2-1.4-1-2.2-1.8-2.6-.9 1-1 2.4-.5 3.3H2c0 4.5 3 8.5 8.5 8.5 4.5 0 8-2.5 9.5-6.5" fill="#2496ed"/>' +
    '<g fill="#2496ed"><rect x="4.5" y="8.5" width="3" height="3"/><rect x="8.5" y="8.5" width="3" height="3"/><rect x="12.5" y="8.5" width="3" height="3"/><rect x="8.5" y="4.5" width="3" height="3"/><rect x="12.5" y="4.5" width="3" height="3"/></g>',
  env:
    `<path d="M4 6h16M4 12h16M4 18h16" stroke="#f5c542" stroke-width="1.8" ${S}/>` +
    '<g fill="#f5c542"><circle cx="9" cy="6" r="2.4"/><circle cx="15" cy="12" r="2.4"/><circle cx="8" cy="18" r="2.4"/></g>',
  git:
    '<path d="M12 1.5 22.5 12 12 22.5 1.5 12z" fill="#f0573f"/>' +
    `<path d="M9 9v6.5M9.5 9.5l4.5 4.2" stroke="#fff" stroke-width="1.5" ${S}/>` +
    '<g fill="#fff"><circle cx="9" cy="8" r="1.7"/><circle cx="9" cy="16.5" r="1.7"/><circle cx="15" cy="14.5" r="1.7"/></g>',
  rspec:
    '<circle cx="12" cy="12" r="10" fill="#d63d38"/>' +
    '<path d="M12 17.5s-5.5-3.3-5.5-7a2.8 2.8 0 0 1 5.5-.9 2.8 2.8 0 0 1 5.5.9c0 3.7-5.5 7-5.5 7z" fill="#fff"/>',
  ts: badge("#3178c6", "#fff", "TS"),
  js: badge("#f0db4f", "#2b2826", "JS"),
  json:
    '<text x="12" y="18" text-anchor="middle" font-family="var(--mono)" font-size="17" font-weight="700" fill="#f5c542">{ }</text>',
  css: `<path d="M9.5 3 7.5 21M16.5 3l-2 18M4 9h17M3 15h17" stroke="#42a5f5" stroke-width="2.2" ${S}/>`,
  html: `<path d="m8 7-5 5 5 5M16 7l5 5-5 5" stroke="#e44d26" stroke-width="2.2" ${S}/>`,
  rust:
    `<circle cx="12" cy="12" r="4" stroke="#dea584" stroke-width="2.2" ${S}/>` +
    `<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="#dea584" stroke-width="2.4" ${S}/>`,
  toml:
    `<path d="M4 4h4M4 4v16M20 4h-4M20 4v16" stroke="#c99a6e" stroke-width="2" ${S}/>` +
    '<text x="12" y="17" text-anchor="middle" font-family="var(--font)" font-size="12" font-weight="800" fill="#c99a6e">T</text>',
  lock:
    `<rect x="5" y="11" width="14" height="10" rx="2" stroke="#a4a09d" stroke-width="1.8" ${S}/>` +
    `<path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="#a4a09d" stroke-width="1.8" ${S}/>`,
  image:
    `<rect x="3" y="3" width="18" height="18" rx="2" stroke="#b47aea" stroke-width="1.8" ${S}/>` +
    `<circle cx="9" cy="9" r="2" stroke="#b47aea" stroke-width="1.8" ${S}/>` +
    `<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" stroke="#b47aea" stroke-width="1.8" ${S}/>`,
  sh: `<path d="m4 7 5 5-5 5M12 17h8" stroke="#4caf50" stroke-width="2.2" ${S}/>`,
  py: badge("#3572a5", "#ffd43b", "Py"),
};

const BY_NAME: Record<string, string> = {
  gemfile: "ruby", rakefile: "ruby", "config.ru": "ruby", ".ruby-version": "ruby",
  dockerfile: "docker", ".dockerignore": "docker",
  ".rspec": "rspec",
  ".gitignore": "git", ".gitattributes": "git", ".gitmodules": "git",
  "package-lock.json": "lock", "gemfile.lock": "lock", "cargo.lock": "lock", "yarn.lock": "lock", "pnpm-lock.yaml": "lock",
};
const BY_EXT: Record<string, string> = {
  rb: "ruby", erb: "html", yml: "yaml", yaml: "yaml", md: "md", markdown: "md",
  ts: "ts", tsx: "ts", mts: "ts", js: "js", jsx: "js", mjs: "js", cjs: "js",
  json: "json", css: "css", html: "html", htm: "html", rs: "rust", toml: "toml", lock: "lock",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", ico: "image", icns: "image",
  sh: "sh", zsh: "sh", bash: "sh", py: "py",
};

export function fileKind(name: string): string | null {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith(".env")) return "env";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return BY_EXT[ext] ?? null;
}

export function fileIcon(name: string, size = 16): string {
  const kind = fileKind(name);
  if (!kind) return icon("file", size);
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${FILE_ICONS[kind]}</svg>`;
}
