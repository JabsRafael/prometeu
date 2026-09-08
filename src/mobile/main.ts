import "./mobile.css";
import { use } from "../i18n";
import * as comments from "../team-comments";
import * as member from "../team-member";
import * as viewer from "../team-viewer";
import { companionId, labelFor, membershipOf, ORGANIZATION_KEY, pickOrganization, readConfig, securityStore, ticketUrl } from "./shell";
import { MobileView } from "./view";

/// Browser composition root: the same collaboration core as the desktop, with viewer and comments only.
/// The Cloud renders the page, authenticates the session and issues companion tickets. See ADR 0028.

const root = document.getElementById("app")!;
const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
const config = readConfig(root, csrf);
use(root.dataset.lang === "en" ? "en" : "pt-BR");

member.useSecurityStore(securityStore(localStorage));
member.register(comments.install);
member.register(viewer.install);

const companion = companionId(localStorage);
const label = labelFor(navigator.userAgent);

const view = new MobileView(root, config, { selectOrganization: select });
viewer.setSink({ live: (tab, bytes) => view.live(tab, bytes), reset: (tab, bytes) => view.reset(tab, bytes) });
member.onChange(() => view.changed());
member.onError((text) => view.toast(text));

function select(id: string) {
  const organization = config.organizations.find((o) => o.id === id);
  if (!organization) return;
  localStorage.setItem(ORGANIZATION_KEY, organization.id);
  member.reset();
  view.setOrganization(organization);
  void member.connect(membershipOf(config, organization, companion, () => ticketUrl(config, organization, companion, label)));
}

const initial = pickOrganization(config, localStorage);
if (initial) select(initial.id);
else view.render();
