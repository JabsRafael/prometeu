import { invoke } from "./ipc";

/// Pasted screenshots and files copied in Finder reach the webview without a path, so the backend
/// materializes them under the private attachments directory. Attaching them here keeps paste and
/// drop equivalent; clipboards without files keep the browser's own paste.
export function pasteFiles(event: ClipboardEvent, put: (paths: string[]) => void, fail: (error: unknown) => void) {
  if (!event.clipboardData?.files.length) return;
  event.preventDefault();
  invoke("paste_files")
    .then((paths) => {
      if (paths.length) put(paths);
    })
    .catch(fail);
}
