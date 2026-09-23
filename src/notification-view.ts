import { button } from "./ui";
import { h } from "./util";
import { icon } from "./icons";
import type { Notice } from "./notifications";

/** Native overlay and browser mock render the same escaped content. */
export function notificationView(notice: Notice, open: () => void, dismiss: () => void) {
  const root = h("div", "notification-popup");
  root.dataset.style = notice.style;
  root.setAttribute("role", "status");
  const action = button("", open, "ghost");
  action.classList.add("notification-popup-open");
  action.setAttribute("aria-label", notice.openLabel);
  const logo = h("span", "notification-logo"); logo.innerHTML = icon("flame", 22);
  const copy = h("span", "notification-copy");
  copy.append(h("strong", "", notice.title), h("span", "", notice.body));
  action.append(logo, copy);
  const close = button("", dismiss, "ghost");
  close.classList.add("notification-popup-close");
  close.setAttribute("aria-label", notice.closeLabel);
  close.innerHTML = icon("x", 14);
  root.append(action, close);
  return root;
}
