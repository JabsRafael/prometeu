/** Bound untrusted request bodies while reading, before allocating the full payload. */
export async function smallJson(req: Request, max: number): Promise<{ value?: unknown; raw?: string; error?: Response }> {
  const tooBig = () => ({ error: new Response("too big", { status: 413 }) });
  if (Number(req.headers.get("Content-Length") ?? "0") > max) {
    await req.body?.cancel().catch(() => {});
    return tooBig();
  }
  const reader = req.body?.getReader();
  if (!reader) return { error: new Response("bad", { status: 400 }) };
  try {
    const decoder = new TextDecoder();
    let size = 0;
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return tooBig();
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    return { value: JSON.parse(raw), raw };
  } catch {
    return { error: new Response("bad", { status: 400 }) };
  } finally {
    reader.releaseLock();
  }
}
