import { readFile } from "node:fs/promises";

/// Fitness function do ADR 0003: componentes de apresentação recebem
/// capabilities e ProviderId prontos. Dispatch por nome pertence ao catálogo
/// (`src/agents.ts`) ou aos adapters Rust, nunca a estas telas.
const presentation = [
  "src/chat.ts",
  "src/launcher.ts",
  "src/main.ts",
  "src/settings.ts",
  "src/statusbar.ts",
  "src/workspace.ts",
];

const forbidden = [
  /(?:===|!==)\s*["'](?:claude|codex)["']|["'](?:claude|codex)["']\s*(?:===|!==)/g,
  /\bcase\s+["'](?:claude|codex)["']/g,
];

const failures = [];
for (const file of presentation) {
  const source = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: decisão de UI por nome do provider: ${match[0]}`);
    }
  }
}

const timeline = await readFile("src/timeline.ts", "utf8");
for (const token of ["stream_event", "control_request", "control_response", "tool_use", "rate_limit_event"]) {
  if (timeline.includes(token)) {
    failures.push(`src/timeline.ts: protocolo de provider no reducer canônico: ${token}`);
  }
}

/// Fitness function do ADR 0002: o adapter Codex cruza a fronteira interna em
/// V1 diretamente. Formas de stream-json pertencem ao adapter do Claude e à
/// compatibilidade de transcript, nunca à saída intermediária do Codex.
const codex = await readFile("src-tauri/src/codex.rs", "utf8");
const legacyCodex = [
  /"(?:stream_event|control_request|control_response|tool_use|tool_result|content_block_(?:start|delta|stop))"/g,
  /"type"\s*:\s*"(?:user|assistant|result)"/g,
  /\bLegacyAdapter\b/g,
];
for (const pattern of legacyCodex) {
  for (const match of codex.matchAll(pattern)) {
    const line = codex.slice(0, match.index).split("\n").length;
    failures.push(`src-tauri/src/codex.rs:${line}: formato legado entre Codex e core: ${match[0]}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error("Mantenha decisões nominais e protocolos externos nas respectivas fronteiras de provider.");
  process.exitCode = 1;
} else {
  console.log(
    `${presentation.length} componentes sem condicionais nominais; timeline e adapter Codex respeitam a fronteira canônica`,
  );
}
