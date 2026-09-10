import { mountFeedback } from "./feedback-client";
import { current, fromBack, t } from "./i18n";
import * as cloud from "./cloud";
import { invoke } from "./ipc";
import { $ } from "./util";
import { version } from "../package.json";

export function init() {
  const widget = mountFeedback({
    source: "desktop", locale: current(), version, error: fromBack,
    origin: () => cloud.current().origin || "https://app.prometeu.co",
    capture: async () => {
      const base64 = await invoke("feedback_capture");
      if (!base64) return;
      return new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], "feedback.png", { type: "image/png" });
    },
  });
  widget.trigger.id = "feedback";
  widget.trigger.className = "ui-button ghost sm";
  widget.trigger.title = t("feedback.trigger");
  widget.trigger.setAttribute("aria-label", t("feedback.trigger"));
  widget.trigger.textContent = t("feedback.trigger");
  $("update").after(widget.trigger);
  widget.root.classList.add("ui-feedback-desktop");
}
