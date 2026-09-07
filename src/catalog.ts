import { listen } from "@tauri-apps/api/event";
import { invoke } from "./ipc";
import { t } from "./i18n";

/// O catálogo na nuvem, visto da tela: quem está lá, e quais plugins de lá
/// ainda não foram instalados neste Mac. O documento mora no back
/// (`src-tauri/src/catalog.rs`); aqui só o que marca cada linha de
/// Configurações. Sem conta, tudo é "deste Mac" e nada é marcado.

export type CatalogState = {
  connected: boolean;
  plugins: { id: string; source: string; note: string }[];
  mcp: string[];
};

let state: CatalogState = { connected: false, plugins: [], mcp: [] };
const watchers = new Set<() => void>();

export const current = () => state;
export const onChange = (fn: () => void) => {
  watchers.add(fn);
  return () => watchers.delete(fn);
};

export async function load() {
  try {
    state = await invoke<CatalogState>("catalog_state");
    for (const fn of watchers) fn();
  } catch {
    // Back anterior à feature: nenhuma linha ganha marca.
  }
}

/// O back avisa quando a nuvem trouxe algo novo para os hubs deste Mac.
export function init(refreshHubs: () => Promise<void>) {
  void load();
  void listen("catalog", async () => {
    await refreshHubs();
    await load();
  }).catch(() => {});
}

/// A marca de uma linha: na nuvem, ou só neste Mac. Sem conta, nenhuma.
export function tag(kind: "plugins" | "mcp", id: string): string {
  if (!state.connected) return "";
  const cloud =
    kind === "plugins"
      ? state.plugins.some((p) => p.id === id)
      : state.mcp.includes(id);
  return cloud ? t("catalog.cloud") : t("catalog.local");
}
