import { mountFeedback, captureScreen } from "./feedback-client";
import { FEEDBACK_EN, FEEDBACK_PT } from "./feedback-i18n";
import "../packages/design-system/components.css";

const source = document.querySelector<HTMLMetaElement>('meta[name="prometeu-feedback-source"]')?.content === "cloud" ? "cloud" : "site";
const origin = source === "cloud" ? location.origin : "https://app.prometeu.co";
const mount = () => mountFeedback({
  source, origin: () => origin, locale: document.documentElement.lang,
  capture: typeof navigator.mediaDevices?.getDisplayMedia === "function" ? async () => {
    try { return await captureScreen(); }
    catch { throw new Error((document.documentElement.lang.startsWith("pt") ? FEEDBACK_PT : FEEDBACK_EN)["feedback.captureError"]); }
  } : undefined,
});
let widget = mount();
new MutationObserver(() => {
  // Keep an in-progress submission or draft when the host switches language.
  if (widget.root.querySelector("textarea")?.value || widget.root.querySelector("form[aria-busy=true], img:not([hidden])")) return;
  widget.destroy(); widget = mount();
})
  .observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
