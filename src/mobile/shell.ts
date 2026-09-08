import { PROTO } from "../../relay/src/protocol";
import { encodeBase64Url } from "../team-crypto";
import type { Membership, SecurityStore } from "../team-ports";

/// Browser shell ports for the collaboration core: companion identity, storage and tickets over the Cloud
/// session. Pure functions over a storage interface so the composition root stays thin. See ADR 0028.

export type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export type Organization = { id: string; slug: string; name: string; member: string };

export type Config = {
  /// Canonical Cloud origin, the same string the desktop stores; it binds the encryption scope.
  origin: string;
  user: { id: string; name: string };
  organizations: Organization[];
  csrf: string;
};

const COMPANION_KEY = "prometeu:companion";
const SECURITY_KEY = "prometeu:mobile-security";
export const ORGANIZATION_KEY = "prometeu:mobile-organization";

/// One relay identity per browser, generated next to the private keys and reused across logins.
export function companionId(storage: Storage): string {
  const saved = storage.getItem(COMPANION_KEY);
  if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
  const id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  storage.setItem(COMPANION_KEY, id);
  return id;
}

/// A short device label for the roster, derived from the user agent; the person's name comes from the Cloud.
export function labelFor(userAgent: string): string {
  return /iPhone|iPad|Android|Macintosh|Windows|Linux/.exec(userAgent)?.[0] ?? "Browser";
}

// ponytail: the private identity is a JWK in web storage, the same schema as team-security.json; move to a
// non-extractable CryptoKey in IndexedDB when hardening against script injection matters.
export function securityStore(storage: Storage): SecurityStore {
  return {
    read: async () => JSON.parse(storage.getItem(SECURITY_KEY) ?? "null"),
    write: async (state) => storage.setItem(SECURITY_KEY, JSON.stringify(state)),
  };
}

/// Mirror src-tauri/src/cloud.rs relay_socket_url so both clients reach the same room.
export function socketUrl(relay: string, organization: string, ticket: string): string {
  const url = new URL(relay);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/organization/${organization}`;
  url.search = "";
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("p", String(PROTO));
  return url.toString();
}

/// Ask the Cloud for a one-time companion ticket; the cookie session and CSRF token authenticate it.
export async function ticketUrl(config: Config, organization: Organization, companion: string, label: string,
  request: typeof fetch = fetch): Promise<string> {
  const response = await request(`/orgs/${encodeURIComponent(organization.slug)}/companion-ticket`, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": config.csrf },
    body: JSON.stringify({ companion, label }),
  });
  if (!response.ok) throw new Error(`ticket ${response.status}`);
  const body = await response.json() as { ticket?: unknown; relay?: unknown };
  if (typeof body.ticket !== "string" || typeof body.relay !== "string") throw new Error("ticket body");
  return socketUrl(body.relay, organization.id, body.ticket);
}

/// The companion joins the organization room as its own member; scopes match the desktop's cryptoScope.
export function membershipOf(config: Config, organization: Organization, companion: string, url: () => Promise<string | null>): Membership {
  const scope = JSON.stringify(["organization", config.origin, organization.id]);
  return {
    member: companion,
    scope,
    privateScope: JSON.stringify([scope, config.user.id, companion]),
    shareScope: `organization:${organization.id}:${companion}`,
    legacy: false,
    url,
  };
}

/// Restore the last organization or fall back to the only one.
export function pickOrganization(config: Config, storage: Storage): Organization | null {
  const saved = storage.getItem(ORGANIZATION_KEY);
  return config.organizations.find((o) => o.id === saved) ?? (config.organizations.length === 1 ? config.organizations[0] : null);
}

/// Read the page configuration the Cloud renders into the root element.
export function readConfig(root: HTMLElement, csrf: string): Config {
  const organizations = JSON.parse(root.dataset.organizations ?? "[]") as unknown;
  if (!Array.isArray(organizations)) throw new Error("organizations");
  return {
    origin: root.dataset.origin ?? "",
    user: { id: root.dataset.userId ?? "", name: root.dataset.userName ?? "" },
    organizations: organizations.filter((o): o is Organization => !!o && typeof o === "object" &&
      ["id", "slug", "name", "member"].every((k) => typeof (o as Record<string, unknown>)[k] === "string")),
    csrf,
  };
}
