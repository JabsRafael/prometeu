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

if (failures.length) {
  console.error(failures.join("\n"));
  console.error("Use AgentCapabilities; dispatch nominal pertence à fronteira do provider.");
  process.exitCode = 1;
} else {
  console.log(`${presentation.length} componentes sem condicionais nominais e timeline sem protocolo de provider`);
}
