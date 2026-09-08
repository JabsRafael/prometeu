import {
  parseCreatedTeam,
  parseMembership,
  type CreatedTeam,
  type EnrollResponse,
} from "../relay/src/protocol";
import { t } from "./i18n";

/// Team-client I/O boundary: HTTP, WebSocket, and relay URLs. team.ts owns state and synchronization.

export type SocketLike = {
  binaryType: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

export type Transport = {
  socket: (url: string) => SocketLike;
  create: (relay: string) => Promise<CreatedTeam>;
  enroll: (relay: string, team: string, secret: string) => Promise<EnrollResponse>;
  /// The mock has no relay and needs no URL.
  needsRelay: boolean;
};

export function relayUrl(relay: string, socket: boolean, needsRelay: boolean): string {
  let url: URL;
  try {
    url = new URL(relay);
  } catch {
    throw t("err.team.relayUrl");
  }
  if (url.username || url.password || url.search || url.hash) throw t("err.team.relayUrl");
  const allowed = new Set(["http:", "https:", "ws:", "wss:"]);
  if (!allowed.has(url.protocol)) throw t("err.team.relayUrl");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (needsRelay && !local && (url.protocol === "http:" || url.protocol === "ws:")) {
    throw t("err.team.insecureRelay");
  }
  url.protocol = socket
    ? url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"
    : url.protocol === "https:" || url.protocol === "wss:" ? "https:" : "http:";
  return url.toString().replace(/\/+$/, "");
}

export const wsUrl = (relay: string, needsRelay: boolean) => relayUrl(relay, true, needsRelay);
export const httpUrl = (relay: string, needsRelay: boolean) => relayUrl(relay, false, needsRelay);

export function defaultTransport(): Transport {
  return {
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    create: async (relay) => {
      let response: Response;
      try {
        response = await fetch(`${httpUrl(relay, true)}/teams`, { method: "POST" });
      } catch (error) {
        throw t("err.team.relay", { cause: String(error) });
      }
      if (!response.ok) throw t("err.team.relay", { cause: `HTTP ${response.status}` });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw t("err.team.bad");
      }
      const created = parseCreatedTeam(body);
      if (!created) throw t("err.team.bad");
      return created;
    },
    enroll: async (relay, team, secret) => {
      let response: Response;
      try {
        response = await fetch(`${httpUrl(relay, true)}/team/${encodeURIComponent(team)}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret }),
        });
      } catch (error) {
        throw t("err.team.relay", { cause: String(error) });
      }
      if (!response.ok) throw t("err.team.relay", { cause: `HTTP ${response.status}` });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw t("err.team.bad");
      }
      const membership = parseMembership(body);
      if (!membership) throw t("err.team.bad");
      return membership;
    },
    needsRelay: true,
  };
}
