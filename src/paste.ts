import { invoke } from "./ipc";

/// Pasted screenshots and files copied in Finder reach the webview without a path, so the backend
/// materializes them under the private attachments directory. Attaching them here keeps paste and
/// drop equivalent; clipboards without files keep the browser's own paste.
export function pasteFiles(event: ClipboardEvent, put: (paths: string[]) => void, fail: (error: unknown) => void) {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  invoke("paste_files")
    // Only macOS reads the native pasteboard; elsewhere the pasted images come from the webview itself.
    .then((paths) => (paths.length ? paths : pastedImages(files)))
    .then((paths) => {
      if (paths.length) put(paths);
    })
    .catch(fail);
}

function pastedImages(files: File[]): Promise<string[]> {
  const images = files.filter((file) => file.type.startsWith("image/"));
  return Promise.all(images.map(async (file) => invoke("paste_image", { data: await base64(file), kind: file.type })));
}

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Chunks keep String.fromCharCode below the engine's argument limit on large screenshots.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
