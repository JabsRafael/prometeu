import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = process.cwd();
const errors = [];

function markdownUnder(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...markdownUnder(path));
    else if (name.endsWith(".md")) files.push(path);
  }
  return files;
}

const roots = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md"]
  .map((file) => join(root, file))
  .filter(existsSync);
const docs = markdownUnder(join(root, "docs"));
const files = [...roots, ...docs];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || target.startsWith("#") || /^[a-z][a-z+.-]*:/i.test(target)) continue;

    target = target.split("#", 1)[0];
    try {
      target = decodeURIComponent(target);
    } catch {
      errors.push(`${relative(root, file)}: link possui escape inválido: ${match[1]}`);
      continue;
    }

    if (!existsSync(resolve(dirname(file), target))) {
      const line = text.slice(0, match.index).split("\n").length;
      errors.push(`${relative(root, file)}:${line}: destino não existe: ${match[1]}`);
    }
  }
}

const index = readFileSync(join(root, "docs", "README.md"), "utf8");
for (const file of docs) {
  const name = relative(join(root, "docs"), file).split(sep).join("/");
  if (name !== "README.md" && !index.includes(`(${name})`)) {
    errors.push(`docs/README.md: não indexa ${name}`);
  }
}

const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
const agentLines = agents.split("\n").length;
if (agentLines > 200) errors.push(`AGENTS.md: ${agentLines} linhas; o limite do mapa curto é 200`);

const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
if (!claude.includes("@AGENTS.md")) errors.push("CLAUDE.md: não importa @AGENTS.md");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`${files.length} documentos válidos e ${docs.length - 1} páginas indexadas`);
}
