import { isId, MEMBERS_MAX, normalizeName } from "./protocol";

export type OrganizationAccess = {
  organization: string;
  member: string;
  name: string;
  expires_at: number;
  members: { id: string; name: string }[];
};

export function parseOrganizationAccess(value: unknown, organization: string, now = Date.now()): OrganizationAccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.organization !== organization || !isId(v.member) || !normalizeName(v.name) ||
    typeof v.expires_at !== "number" || !Number.isSafeInteger(v.expires_at) || v.expires_at <= now ||
    !Array.isArray(v.members) || v.members.length > MEMBERS_MAX) return null;
  const members: OrganizationAccess["members"] = [];
  for (const item of v.members) {
    if (!item || typeof item !== "object" || !isId(item.id) || !normalizeName(item.name) || members.some(m => m.id === item.id)) return null;
    members.push({ id: item.id, name: normalizeName(item.name) });
  }
  if (!members.some(m => m.id === v.member && m.name === normalizeName(v.name))) return null;
  return { organization, member: v.member, name: normalizeName(v.name), expires_at: Math.min(v.expires_at, now + 60_000), members };
}

export async function authorizeOrganization(origin: string, organization: string, ticket: string): Promise<OrganizationAccess | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  try {
    const url = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || local && url.protocol === "http:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    const response = await fetch(`${url.origin}/api/relay/authorize`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization, ticket }), redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const raw = await response.text();
    if (raw.length > 16_384) return null;
    return parseOrganizationAccess(JSON.parse(raw), organization);
  } catch {
    return null;
  }
}
