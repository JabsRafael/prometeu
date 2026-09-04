/// Ícones Lucide desenhados inline: sem fonte de ícone, sem pacote. Cada um é
/// só o miolo do <svg>; tamanho e cor vêm do CSS (`currentColor`).
const PATHS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  ellipsis: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "panel-left": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  "panel-right": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  "folder-open":
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  "folder-plus":
    '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  diff: '<path d="M12 3v14"/><path d="M5 10h14"/><path d="M5 21h14"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  square: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  coffee:
    '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M6 2v2"/>' +
    '<path d="M4 8h14a1 1 0 0 1 1 1v2a4 4 0 0 1-4 4h-1a5 5 0 0 1-10 0V9a1 1 0 0 1 1-1Z"/>' +
    '<path d="M19 9h1a3 3 0 0 1 0 6h-1"/><path d="M3 21h16"/>',
  memory:
    '<path d="M6 19v-3"/><path d="M10 19v-3"/><path d="M14 19v-3"/><path d="M18 19v-3"/>' +
    '<path d="M8 11V9"/><path d="M16 11V9"/><path d="M12 11V9"/>' +
    '<path d="M2 15h20"/><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4Z"/>',
  plug:
    '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/>' +
    '<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  play: '<path d="M6 4.5v15l13-7.5Z"/>',
  puzzle:
    '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  // Seis barras que o CSS faz subir e descer: é o "tem coisa rodando" da aba.
  // Todas nascem centradas em y≈12, então uma origem só (`12px 12px`) serve
  // para as seis — sem `transform-box`, que em traço de largura zero é terreno
  // movediço no WebKit.
  "audio-lines":
    '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  "share-2":
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  "message-square": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  "at-sign": '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  "wifi-off":
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  // A marca do Linear é preenchida, não traçada: as quatro faixas viram um
  // círculo. Desenhada em 100×100 e reduzida para caber na caixa de 24.
  linear:
    '<g transform="scale(.24)" fill="currentColor" stroke="none"><path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3079.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z"/></g>',
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
  "git-branch":
    '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  "git-pull-request":
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  // Os quatro do rodapé do lançador, na ordem do Conductor: modelo, esforço,
  // plan mode e anexo.
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  signal: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/>',
  map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
  paperclip:
    '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>',
  pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  "archive-restore":
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="m9 15 3-3 3 3"/><path d="M12 12v6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "git-merge": '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  pin:
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  "pin-off":
    '<path d="M12 17v5"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/><path d="M14 4.09V7a1 1 0 0 0 .3.71l3.99 3.99A2 2 0 0 1 19 13.24V16"/><path d="M8 2h8a2 2 0 0 1 0 4 1 1 0 0 0-1 1"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  mail:
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  "mail-open":
    '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>',
  // O olho abre a revisão do diff; o cérebro marca o pensamento do agente.
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  brain:
    '<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/>' +
    '<path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/>' +
    '<path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/>' +
    '<path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>',
};

export type IconName = keyof typeof PATHS;

/// A onda que diz que tem processo de pé, no lugar do ponto verde que havia.
/// Cor parada não separa "está rodando" de "parou faz um segundo"; movimento
/// separa. E ela herda a cor da aba de propósito — o recado é a animação, não
/// mais um tom a decorar a barra.
export const wave = (size = 14) => icon("audio-lines", size, "wave");

export function icon(name: IconName, size = 16, extra = ""): string {
  return (
    `<svg class="ic${extra ? ` ${extra}` : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    PATHS[name] +
    "</svg>"
  );
}

/* ---------- ícone de etapa ---------- */

/// O anel que enche conforme o trabalho anda: a primeira etapa é o anel
/// tracejado (nada começou), as do meio enchem por fração, e a última é o
/// check. O desenho sai da posição na lista — trocar as etapas troca os
/// ícones, e não existe tabela de nome para ícone para manter.
export function stageIcon(at: number, total: number, size = 16): string {
  const svg = (inner: string, color = "currentColor") =>
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    inner +
    "</svg>";

  const ring = '<circle cx="12" cy="12" r="9"/>';
  if (at <= 0) return svg('<circle cx="12" cy="12" r="9" stroke-dasharray="2.6 2.6"/>');
  if (at >= total - 1) return svg(`${ring}<path d="m8.5 12 2.5 2.5 4.5-5"/>`, "var(--done)");

  // O miolo é um círculo de raio 4 com traço grosso: o `dasharray` come a volta
  // dele, então a fatia cheia é a fração do perímetro (2π·4 ≈ 25,1). A ponta
  // tem de ser reta: arredondada, o traço de 8 de largura põe meia largura de
  // arco a mais em cada ponta e um quarto vira quase o círculo inteiro.
  const fill = (25.1 * at) / (total - 1);
  return svg(
    `${ring}<circle cx="12" cy="12" r="4" stroke-width="8" stroke-linecap="butt" ` +
      `stroke-dasharray="${fill.toFixed(1)} 25.1" transform="rotate(-90 12 12)"/>`,
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

/* ---------- marcas ---------- */

/// O selo de quem responde: a estrela da Anthropic e a flor da OpenAI, nas
/// cores delas. Não são ícones de traço como o resto: a marca precisa continuar
/// reconhecível tanto na lista de workspaces quanto no consumo do rodapé.
const BRANDS: Record<string, string> = {
  claude:
    '<g fill="#d97757" transform="translate(12 12)">' +
    Array.from({ length: 8 }, (_, i) => `<rect x="-1.05" y="-9.5" width="2.1" height="19" rx="1.05" transform="rotate(${i * 22.5})"/>`).join("") +
    "</g>",
  codex:
    '<path fill="#a4a09d" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.98 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.91 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.748-7.073zm-9.022 12.608a4.476 4.476 0 0 1-2.876-1.04l.142-.081 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.305a4.471 4.471 0 0 1-.535-3.014l.142.085 4.783 2.758a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.499 4.499 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.814 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.834-3.388L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.499 4.499 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.499 4.499 0 0 1 7.375-3.454l-.142.08-4.778 2.76a.795.795 0 0 0-.393.68zm1.097-2.366 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z"/>',
};

export function brand(name: string, size = 14): string {
  const art = BRANDS[name];
  if (!art) return icon("sparkles", size);
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${art}</svg>`;
}
