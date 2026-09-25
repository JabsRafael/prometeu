import { expect, it, vi } from "vitest";
import { invoke } from "./ipc";
import { pasteFiles } from "./paste";

vi.mock("./ipc", () => ({ invoke: vi.fn() }));

const event = (files: unknown[]) =>
  ({ clipboardData: { files }, preventDefault: vi.fn() }) as unknown as ClipboardEvent & { preventDefault: ReturnType<typeof vi.fn> };

it("attaches materialized paths and keeps the default paste for text", async () => {
  vi.mocked(invoke).mockResolvedValue(["/private/attachments/pasted.png"]);
  const put = vi.fn();
  const fail = vi.fn();

  const text = event([]);
  pasteFiles(text, put, fail);
  expect(text.preventDefault).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();

  const image = event([{}]);
  pasteFiles(image, put, fail);
  expect(image.preventDefault).toHaveBeenCalled();
  await vi.waitFor(() => expect(put).toHaveBeenCalledWith(["/private/attachments/pasted.png"]));
  expect(fail).not.toHaveBeenCalled();
});

it("reports backend failures instead of attaching nothing silently", async () => {
  vi.mocked(invoke).mockRejectedValue("chat.drop.failed");
  const put = vi.fn();
  const fail = vi.fn();

  pasteFiles(event([{}]), put, fail);
  await vi.waitFor(() => expect(fail).toHaveBeenCalledWith("chat.drop.failed"));
  expect(put).not.toHaveBeenCalled();
});

it("materializes the pasted images itself when the backend has no native pasteboard", async () => {
  vi.mocked(invoke).mockImplementation((async (command: string) =>
    command === "paste_files" ? [] : "/private/attachments/pasted.png") as typeof invoke);
  const put = vi.fn();
  const fail = vi.fn();
  const screenshot = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });
  const text = new File(["notes"], "notes.txt", { type: "text/plain" });

  pasteFiles(event([screenshot, text]), put, fail);
  await vi.waitFor(() => expect(put).toHaveBeenCalledWith(["/private/attachments/pasted.png"]));
  expect(invoke).toHaveBeenCalledWith("paste_image", { data: "iVBORw==", kind: "image/png" });
  expect(invoke).not.toHaveBeenCalledWith("paste_image", expect.objectContaining({ kind: "text/plain" }));
  expect(fail).not.toHaveBeenCalled();
});
