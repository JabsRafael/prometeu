import { t } from "./i18n";
import { invoke } from "./ipc";
import type { PathEntry } from "./paths";
import { searchablePicker, type SearchPickerItem } from "./ui";

/// Command-P palette: the backend's indexed fuzzy path search ranks each query, so the picker
/// shows its results as given. Directories are left out because opening one has no viewer.
export function openQuickOpen(anchor: HTMLElement, id: string, recent: string[], open: (path: string) => void) {
  // A slower response for an earlier query must not replace newer results.
  let asked = 0;
  const rows = (list: PathEntry[]): SearchPickerItem[] =>
    list
      .filter((entry) => !entry.dir)
      .map((entry) => {
        const cut = entry.path.lastIndexOf("/");
        return { key: entry.path, label: entry.name, detail: cut < 0 ? undefined : entry.path.slice(0, cut) };
      });
  const picker = searchablePicker(anchor, {
    label: t("quickOpen.label"),
    searchPlaceholder: t("quickOpen.search"),
    empty: t("quickOpen.empty"),
    items: [],
    select: open,
    search: (query) => void load(query),
  });
  async function load(query: string) {
    const mine = ++asked;
    let list: PathEntry[] = [];
    try {
      list = await invoke("find_paths", { id, query: query.trim(), recent });
    } catch {
      list = [];
    }
    if (mine === asked) picker.update(rows(list));
  }
  void load("");
}
