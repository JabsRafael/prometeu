/// Open agent links in the system browser instead of navigating the application window. The embedded browser remains dedicated to Run.
import { invoke } from "./ipc";
import { fromBack } from "./i18n";

/// Only HTTP/HTTPS links open externally; return null for rejected links and local anchors.
export function external(href: string | null | undefined): string | null {
  return href && /^https?:\/\//i.test(href) ? href : null;
}

export function init(say: (m: string, err?: boolean) => void) {
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a");
    if (!a) return;
    // No link may navigate the application window, including unsupported schemes.
    e.preventDefault();
    const url = external(a.getAttribute("href"));
    if (url) invoke("open_external", { url }).catch((err) => say(fromBack(err), true));
  });
}
