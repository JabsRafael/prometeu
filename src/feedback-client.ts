import { feedbackWidget, type Feedback, type FeedbackLabels } from "../packages/design-system/src/feedback";
import { FEEDBACK_EN, FEEDBACK_PT } from "./feedback-i18n";

export function mountFeedback(options: {
  source: "desktop" | "site" | "cloud";
  origin: () => string;
  locale: string;
  version?: string;
  capture?: () => Promise<File | undefined>;
  error?: (cause: unknown) => string;
}) {
  const copy = options.locale.startsWith("pt") ? FEEDBACK_PT : FEEDBACK_EN;
  const labels = Object.fromEntries(Object.entries(copy).map(([key, value]) => [key.slice("feedback.".length), value])) as FeedbackLabels;
  let request: { id: string; body: string } | undefined;
  return feedbackWidget({
    labels,
    error: cause => cause instanceof Error ? cause.message : options.error?.(cause) ?? String(cause),
    capture: options.capture,
    submit: async (feedback: Feedback) => {
      const image = feedback.image ? { type: feedback.image.type, data: await encodeImage(feedback.image) } : undefined;
      const content = JSON.stringify({ kind: feedback.kind, description: feedback.description, source: options.source, version: options.version, image });
      if (request?.body !== content) request = { id: crypto.randomUUID(), body: content };
      const response = await fetch(`${options.origin()}/api/feedback`, {
        method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...JSON.parse(content), id: request.id }), signal: AbortSignal.timeout(30_000),
      }).catch(() => { throw new Error(copy["feedback.sendError"]); });
      if (!response.ok) {
        if (response.status === 429) throw new Error(copy["feedback.rateLimit"]);
        const body = await response.json().catch(() => null);
        if (body?.error === "uncertain") throw new Error(`${copy["feedback.uncertain"]} ${request.id}`);
        throw new Error(copy["feedback.sendError"]);
      }
      const result = await response.json();
      if (result.id !== request.id) throw new Error(copy["feedback.sendError"]);
      request = undefined;
    },
  });
}

function encodeImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Capture a browser-selected surface, then release every track, including on cancellation/failure. */
export async function captureScreen(): Promise<File | undefined> {
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
  catch (cause) { if (cause instanceof DOMException && cause.name === "NotAllowedError") return; throw cause; }
  try {
    const video = document.createElement("video");
    video.muted = true; video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Capture failed");
    return new File([blob], "feedback.png", { type: "image/png" });
  } finally { stream.getTracks().forEach(track => track.stop()); }
}
