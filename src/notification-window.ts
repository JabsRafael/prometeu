import { listen } from "@tauri-apps/api/event";
import { invoke } from "./ipc";
import type { Notice } from "./notifications";
import { notificationView } from "./notification-view";
import "../packages/design-system/components.css";
import "./notifications.css";

let received = false;
function draw(notice: Notice | null) {
  document.body.replaceChildren();
  if (!notice) return;
  document.body.append(notificationView(notice,
    () => { void invoke("notification_open").catch(console.error); },
    () => { void invoke("notification_dismiss").catch(console.error); }));
}
await listen<Notice>("notification", ({ payload }) => { received = true; draw(payload); });
const current = await invoke("notification_current");
if (!received) draw(current);
