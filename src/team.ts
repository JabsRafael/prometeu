import { listen } from "@tauri-apps/api/event";
import {
  DOWN_FRAME_MAX,
  PROTO,
  SNAPSHOT,
  decodeBinary,
  encodeLive,
  encodeSnapshot,
  formatInvite,
  normalizeName,
  parseDown,
  parseInvite,
  parseMembership,
  type Down,
  type Inbox,
  type Member,
  type Note,
  type Segment,
  type Share,
  type Shared,
  type Up,
  type Watching,
} from "../relay/src/protocol";
import type { CloudStatus } from "./cloud";
import { fromBack, t } from "./i18n";
import { AttachLifecycle } from "./attach-lifecycle";
import { invoke } from "./ipc";
import { Mirror } from "./mirror";
import { remoteControl } from "./team-control";
import { TeamSecurity } from "./team-security";
import { TeamChannel } from "./team-channel";
import { fingerprint } from "./team-crypto";
import {
  defaultTransport,
  wsUrl as transportWsUrl,
  type SocketLike,
  type Transport,
} from "./team-transport";
import type { Board, Workspace } from "./types";

export type { SocketLike, Transport } from "./team-transport";

/// Coordinate relay connection, presence, shares and comments in the frontend through the encrypted channel. The backend persists team credentials and private security state. One reconnecting connection serves local share ownership and remote viewing; authenticated welcome content rebuilds remote state.

export type TeamConfig = {
  /// Relay URL override.
  relay: string | null;
  team: string;
  secret: string;
  /// Individual member identity and proof issued during enrollment.
  member: string;
  credential: string;
  name: string;
  cloud?: { user: string; origin: string; slug: string; name: string };
};

export type Organization = { id: string; slug: string; name: string; member: string; role: "owner" | "admin" | "member" };
let organizations: Organization[] = [];
let account: CloudStatus = { user: null, origin: "", offline: false };
let organizationRequest = 0;
let connection = 0;
let channel: TeamChannel | null = null;
let wireQueue: Promise<void> = Promise.resolve();
let queuedWireBytes = 0;
let identityLoading: Promise<unknown> = Promise.resolve();
const accessVersions = new Map<string, number>();
const pendingAudience = new Map<string, string[] | null | false>();

const cryptoScope = (c: TeamConfig) => JSON.stringify(c.cloud
  ? ["organization", c.cloud.origin, c.team]
  : ["team", relayOf(c), c.team]);
const privateScope = (c: TeamConfig) => JSON.stringify([cryptoScope(c), c.cloud?.user ?? "", c.member]);

function encryptedWork(bytes: number, work: () => Promise<void>) {
  if (queuedWireBytes + bytes > 16 * 1024 * 1024) {
    fail?.(t("err.team.encryption")); return false;
  }
  const generation = connection;
  queuedWireBytes += bytes;
  wireQueue = wireQueue.then(async () => {
    if (generation === connection) await work();
  }).catch(() => {
    if (generation === connection) fail?.(t("err.team.encryption"));
  }).finally(() => { queuedWireBytes -= bytes; });
  return true;
}

export const securityChanges = () => channel?.security.changedKeys() ?? [];
export const securityCode = (member?: string) => channel?.security.code(member) ?? Promise.reject(t("err.team.encryption"));
export async function securityChangeCodes(member: string) {
  const change = channel?.security.changedKeys().find(c => c.member === member);
  if (!change) throw t("err.team.encryption");
  return { previous: await fingerprint(change.previous), next: await fingerprint(change.next) };
}
export async function acceptSecurityKey(member: string, expectedKey: string) {
  await wireQueue;
  if (!channel || channel.security.changedKeys().find(c => c.member === member)?.next !== expectedKey) throw t("err.team.encryption");
  await channel.security.accept(member);
  disconnect(); void connect(); changed();
}

export type Phase = "off" | "connecting" | "online";

/// Use the deployed relay unless Settings or VITE_RELAY overrides it.
const RELAY = "wss://prometeu-relay.prometheus-capim.workers.dev";

/// Split retained transcripts into whole-line chunks, leaving room for encryption and encoding within the relay's 1 MiB binary frame limit.
const SNAPSHOT_PART = 128 * 1024;
/// Batch output for 40 ms to reduce relay message count without perceptible display delay.
const COALESCE = 40;
const FRAME_MAX = 32 * 1024;
/// After snapshot timeout, open with the available mirror if the owner disappeared.
const SNAPSHOT_WAIT = 10_000;

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

/* External I/O. */

const enc = new TextEncoder();

let transport: Transport = defaultTransport();

export function useTransport(next: Transport) {
  transport = next;
}

/// Destination for live lines of the displayed remote conversation.
export type GuestSink = {
  live: (tab: string, bytes: Uint8Array) => void;
  /// Replace the view when a fresh snapshot arrives after owner or connection recovery.
  reset: (tab: string, bytes: Uint8Array) => void;
};

let guest: GuestSink = { live: () => {}, reset: () => {} };
export const setSink = (sink: GuestSink) => void (guest = sink);

/* State. */

let cfg: TeamConfig | null = null;
let defaultName = "";
/// Retain a pre-enrollment relay override for eventual team.json persistence.
let relayDraft = "";
let phase: Phase = "off";
let sock: SocketLike | null = null;
let you: string | null = null;
let members: Member[] = [];
let shares = new Map<string, Shared>();
let inbox: Inbox[] = [];
let comments = false;
/// Cache only workspace comments requested so far; other threads load when opened.
const notes = new Map<string, Note[]>();
let attempt = 0;
let retry = 0;
let pinger = 0;

const listeners = new Set<() => void>();
export const onChange = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const changed = () => listeners.forEach((cb) => cb());

let fail: ((text: string) => void) | null = null;
export const onError = (cb: (text: string) => void) => void (fail = cb);

export type TeamStatus = {
  config: TeamConfig | null;
  phase: Phase;
  you: string | null;
  members: Member[];
  defaultName: string;
  /// Expose the configured override, application default, and effective relay URL.
  relay: string;
  relayDefault: string;
  relayEffective: string;
  organizations: Organization[];
  account: CloudStatus;
};

export const status = (): TeamStatus => ({
  config: cfg,
  phase,
  you,
  members,
  defaultName,
  relay: cfg ? (cfg.relay ?? "") : relayDraft,
  relayDefault: env?.VITE_RELAY || RELAY,
  relayEffective: relayOf(cfg),
  organizations,
  account,
});

export const nameOf = (member: string) => members.find((m) => m.id === member)?.name ?? member.slice(0, 8);
export const invite = () => (cfg && !cfg.cloud ? formatInvite(cfg.team, cfg.secret) : null);
export const inboxItems = () => inbox;
export const supportsThreads = () => comments;

/* Lifecycle. */

export async function init() {
  try {
    const file = await invoke("team_config");
    defaultName = file.default_name;
    const stored = storedConfig(file.config);
    if (stored) relayDraft = stored.relay ?? "";
    if (stored?.credential || stored?.cloud) {
      cfg = { ...stored, credential: stored.credential ?? "" };
    } else if (stored) {
      // Exchange legacy v2 shared-secret identity for v3 enrollment without destroying old configuration if migration fails.
      const base = relayOf(stored);
      try {
        if (!base) throw new Error(t("err.team.noRelay"));
        const membership = await transport.enroll(base, stored.team, stored.secret);
        cfg = { ...stored, ...membership };
        await invoke("team_config_set", { config: cfg });
      } catch {
        cfg = null;
        fail?.(t("err.team.legacy"));
      }
    }
  } catch {
    // Keep the interface usable without team state if the backend is unavailable or older.
  }
  // Forward local conversation lines only for tabs with viewers.
  listen<[string, string, number]>("chat", ({ payload: [key, line, seq] }) => output(key, line, seq));
  if (cfg && !cfg.cloud) await connect();
}

export async function refreshOrganizations(value: CloudStatus) {
  const request = ++organizationRequest;
  const identityChanged = account.user?.id !== value.user?.id || account.origin !== value.origin;
  account = value;
  if (identityChanged || !value.user) organizations = [];
  if (cfg?.cloud && (!value.user || cfg.cloud.user !== value.user.id || cfg.cloud.origin !== value.origin)) {
    disconnect(); reset(); cfg = null;
  }
  changed();
  if (!value.user || value.offline) return;
  try {
    const result = await invoke("cloud_organizations");
    if (request !== organizationRequest || result.user?.id !== account.user?.id || result.origin !== account.origin) return;
    organizations = result.organizations;
    if (cfg?.cloud) {
      const org = organizations.find(org => org.id === cfg!.team && org.member === cfg!.member);
      if (!org) { disconnect(); reset(); cfg = null; }
      else {
        cfg = { ...cfg, name: value.user.name, cloud: { ...cfg.cloud, slug: org.slug, name: org.name } };
        if (!sock && !retry) void connect();
      }
    }
    changed();
  } catch (error) {
    if (request === organizationRequest) fail?.(fromBack(error));
  }
}

export async function selectOrganization(id: string) {
  const org = organizations.find(item => item.id === id);
  if (!org || !account.user) throw t("err.cloud.response");
  await adopt({ relay: null, team: org.id, secret: "", credential: "", member: org.member, name: account.user.name,
    cloud: { user: account.user.id, origin: account.origin, slug: org.slug, name: org.name } });
}

/// Resolve relay from configuration, development override, then application default; the browser mock uses a fake endpoint.
type StoredTeamConfig = Omit<TeamConfig, "credential"> & { credential?: string };

function storedConfig(value: unknown): StoredTeamConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.cloud && typeof raw.cloud === "object" && !Array.isArray(raw.cloud)) {
    const cloud = raw.cloud as Record<string, unknown>;
    if (typeof raw.team !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(raw.team) ||
      typeof raw.member !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(raw.member) ||
      typeof raw.name !== "string" || !raw.name.trim() ||
      !["user", "origin", "slug", "name"].every(key => typeof cloud[key] === "string" && (cloud[key] as string).length > 0)) return null;
    return { relay: null, team: raw.team, member: raw.member, secret: "", credential: "", name: raw.name,
      cloud: cloud as TeamConfig["cloud"] };
  }
  if (raw.relay !== null && typeof raw.relay !== "string") return null;
  if (typeof raw.team !== "string" || typeof raw.secret !== "string" || typeof raw.member !== "string") return null;
  const name = normalizeName(raw.name);
  if (!name) return null;
  if (!parseInvite(formatInvite(raw.team, raw.secret))) return null;
  if (!parseMembership({ member: raw.member, credential: raw.credential ?? "" }) && raw.credential !== undefined) return null;
  return {
    relay: raw.relay,
    team: raw.team,
    secret: raw.secret,
    member: raw.member,
    credential: raw.credential as string | undefined,
    name,
  };
}

const relayOf = (c: Pick<TeamConfig, "relay"> | StoredTeamConfig | null) =>
  (c ? c.relay || "" : relayDraft) || env?.VITE_RELAY || RELAY || (transport.needsRelay ? "" : "ws://mock");

/// Convert HTTP(S) endpoints to WS(S), preserving existing WebSocket schemes.
const wsUrl = (relay: string) => transportWsUrl(relay, transport.needsRelay);

async function connect() {
  if (!cfg) return;
  retry = 0;
  const generation = ++connection;
  const base = relayOf(cfg);
  if (!base) {
    phase = "off";
    changed();
    return;
  }
  const c = cfg;
  let url: string;
  try {
    await wireQueue;
    const loading = identityLoading.catch(() => {}).then(() => TeamSecurity.load(privateScope(c), () => invoke("team_security"), state => invoke("team_security_set", { state })));
    identityLoading = loading;
    const security = await loading;
    if (generation !== connection) return;
    channel = new TeamChannel(security, cryptoScope(c), c.member);
    for (const workspace of lastBoard?.workspaces ?? []) {
      if (sharedHere(workspace) && !workspace.remote && !workspace.archived && !workspace.cleaned) channel.own(toShare(workspace));
    }
    if (c.cloud) {
      if (account.user?.id !== c.cloud.user || account.origin !== c.cloud.origin) return;
      phase = "connecting"; changed();
      url = await invoke("cloud_relay_ticket", { organization: c.team, user: c.cloud.user, expectedOrigin: c.cloud.origin });
      if (generation !== connection) return;
    } else {
      const endpoint = new URL(`${wsUrl(base)}/team/${encodeURIComponent(c.team)}`);
      endpoint.searchParams.set("c", c.credential);
      endpoint.searchParams.set("m", c.member);
      endpoint.searchParams.set("n", c.name);
      endpoint.searchParams.set("p", String(PROTO));
      url = endpoint.toString();
    }
  } catch (e) {
    if (generation !== connection) return;
    phase = "off";
    fail?.(fromBack(e));
    changed();
    if (c.cloud) retry = setTimeout(() => void connect(), backoff());
    return;
  }
  phase = "connecting";
  changed();
  let s: SocketLike;
  try {
    s = transport.socket(url);
  } catch (error) {
    phase = "off";
    fail?.(t("err.team.relay", { cause: String(error) }));
    changed();
    return;
  }
  s.binaryType = "arraybuffer";
  sock = s;
  s.onopen = () => {
    if (sock !== s) return;
    attempt = 0;
    // Keep idle sockets alive without waking unnecessary relay work.
    pinger = setInterval(() => s.send("ping"), 30_000);
  };
  s.onmessage = (ev) => {
    if (sock !== s) return;
    if (typeof ev.data === "string") {
      if (ev.data === "pong") return;
      // Bound incoming JSON before parsing because a configurable relay may be hostile.
      if (ev.data.length > DOWN_FRAME_MAX || enc.encode(ev.data).byteLength > DOWN_FRAME_MAX) {
        s.close();
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const frame = parseDown(raw);
      if (!frame) return;
      const activeChannel = channel;
      if (!activeChannel) return;
      encryptedWork(ev.data.length, async () => {
        const plain = await activeChannel.incoming(frame);
        if (sock !== s) return;
        if (frame.t === "welcome") {
          const identity = await activeChannel.identity(frame.challenge!);
          if (sock === s) s.send(JSON.stringify(identity));
        }
        if (plain) handle(plain);
        changed();
      });
    } else if (ev.data instanceof ArrayBuffer) {
      const data = ev.data;
      const activeChannel = channel;
      if (activeChannel) encryptedWork(data.byteLength, async () => {
        const plain = await activeChannel.incomingBinary(data);
        if (sock === s) binary(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer);
      });
    }
  };
  s.onclose = () => {
    if (sock !== s) return;
    sock = null;
    attachLife.completeCurrent();
    clearInterval(pinger);
    members = members.map((m) => ({ ...m, online: false }));
    for (const sh of shares.values()) sh.online = false;
    announced.clear();
    watchers.clear();
    holding.clear(); queue.clear(); queued = 0;
    clearTimeout(flushTimer); flushTimer = 0;
    phase = cfg ? "connecting" : "off";
    changed();
    if (cfg) retry = setTimeout(connect, backoff());
  };
  s.onerror = () => {
    // The following close event schedules reconnection.
  };
}

/// Reconnect with exponential backoff from one to thirty seconds and jitter to avoid synchronized retries.
function backoff(): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt++);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function disconnect() {
  connection++;
  clearTimeout(retry);
  retry = 0;
  clearInterval(pinger);
  attachLife.completeCurrent();
  const s = sock;
  sock = null;
  s?.close();
  phase = "off";
  channel = null;
  holding.clear(); queue.clear(); queued = 0;
  clearTimeout(flushTimer); flushTimer = 0;
}

function send(frame: Up, completion?: (sent: boolean) => void): boolean {
  if (!sock || phase !== "online" || !channel) return false;
  const current = sock, active = channel;
  const ws = frame.t === "share" ? frame.share.id : "ws" in frame ? frame.ws : undefined;
  const content = frame.t === "write" || frame.t === "note" || frame.t === "note_reply" || frame.t === "note_resolve";
  if (ws && content && pendingAudience.has(ws)) return false;
  if (ws && (frame.t === "share" || frame.t === "unshare")) accessVersions.set(ws, (accessVersions.get(ws) ?? 0) + 1);
  const version = ws ? accessVersions.get(ws) : undefined;
  return encryptedWork(JSON.stringify(frame).length, async () => {
    try {
      if (ws && (version !== accessVersions.get(ws) || (content && pendingAudience.has(ws)))) { completion?.(false); return; }
      const encrypted = await active.outgoing(frame);
      const valid = sock === current && (!ws || (version === accessVersions.get(ws) && (!content || !pendingAudience.has(ws))));
      if (valid) current.send(JSON.stringify(encrypted));
      completion?.(valid);
    } catch (error) { completion?.(false); throw error; }
  });
}

function sendConfirmed(frame: Up): Promise<boolean> {
  return new Promise(resolve => {
    const generation = connection;
    if (!send(frame, resolve)) resolve(false);
    // A canceled connection skips queued operations, including their callback.
    wireQueue.finally(() => { if (generation !== connection) resolve(false); });
  });
}

function sendBinary(data: Uint8Array): boolean {
  if (!sock || phase !== "online" || !channel) return false;
  const current = sock, active = channel;
  const inner = decodeBinary(data);
  if (!inner) return false;
  const ws = lastBoard?.workspaces.find(w => w.tabs.some(t => t.id === inner.tab))?.id;
  const version = ws ? accessVersions.get(ws) : undefined;
  return encryptedWork(data.length, async () => {
    if (!mine(inner.tab) || (ws && version !== accessVersions.get(ws))) return;
    if (inner.kind === SNAPSHOT && !canReceive(inner.tab, inner.to)) return;
    const encrypted = await active.outgoingBinary(data, (watchers.get(inner.tab) ?? []).filter(member => canReceive(inner.tab, member)));
    if (sock === current && mine(inner.tab) && (!ws || version === accessVersions.get(ws))) for (const frame of encrypted) current.send(frame);
  });
}

/* Incoming frames. */

/// Missing-share/tab errors often result from automatic refreshes; avoid displaying unsolicited errors for already-removed resources.
const QUIET = new Set(["noShare", "noTab"]);

function handle(frame: Down) {
  switch (frame.t) {
    case "welcome":
      you = frame.you;
      members = frame.members;
      shares = new Map(frame.shares.map((s) => [s.id, s]));
      inbox = frame.inbox;
      comments = frame.comments === 1;
      phase = "online";
      // After welcome, reannounce local shares and resnapshot their viewers before sending requests so the relay knows their identities.
      announced.clear();
      if (cfg?.cloud && lastBoard) {
        for (const share of frame.shares) {
          const local = lastBoard.workspaces.find(w => w.id === share.id);
          if (share.owner === frame.you && local && (!sharedHere(local) || local.archived || local.cleaned)) {
            send({ t: "unshare", ws: share.id });
          }
        }
      }
      if (lastBoard) boardChanged(lastBoard);
      // Refresh cached comments only for currently known shares; historical cache entries must not trigger repeated missing-share requests.
      const asked = [...notes.keys()].filter(known);
      notes.clear();
      for (const ws of asked) send({ t: "notes", ws });
      rewatch(frame.watching);
      if (attached) send({ t: "attach", ws: attached.ws, tab: attached.tab });
      break;
    case "presence":
      members = frame.members;
      announced.clear();
      if (lastBoard) boardChanged(lastBoard);
      break;
    case "share":
      shares.set(frame.share.id, frame.share);
      break;
    case "unshare":
      shares.delete(frame.ws);
      notes.delete(frame.ws);
      inbox = inbox.filter((item) => item.ws !== frame.ws);
      for (const [id, r] of remoteIds) if (r.ws === frame.ws) remoteIds.delete(id);
      if (attached?.ws === frame.ws) {
        attachLife.cancel();
        attached = null;
      }
      break;
    case "watch":
      watched(frame.tab, frame.members, frame.added);
      break;
    case "write":
      typed(frame.ws, frame.tab, frame.data, frame.from);
      return;
    // Ignore legacy terminal-size frames; conversations no longer use PTY geometry.
    case "size":
      return;
    case "inbox":
      inbox = frame.items;
      break;
    case "note": {
      const list = notes.get(frame.note.ws) ?? [];
      // Insert new comments/replies and replace resolved roots by ID while preserving history order.
      const at = list.findIndex((n) => n.id === frame.note.id);
      if (at === -1) list.push(frame.note);
      else list[at] = frame.note;
      list.sort((a, b) => a.ts - b.ts);
      notes.set(frame.note.ws, list);
      break;
    }
    case "notes":
      notes.set(frame.ws, frame.items);
      break;
    case "error": {
      // Uncorrelated missing-resource errors usually answer background requests. Let unshare reconcile the UI instead of showing unrelated header warnings.
      if (QUIET.has(frame.code)) return;
      // Fall back to a generic failure for unknown codes from newer relays.
      const key = `err.team.${frame.code}` as Parameters<typeof t>[0];
      const text = t(key);
      fail?.(text === key ? t("err.team.bad") : text);
      return;
    }
    default:
      return;
  }
  changed();
}

/* Team actions. */

async function adopt(next: TeamConfig) {
  await invoke("team_config_set", { config: next });
  disconnect();
  reset();
  cfg = next;
  attempt = 0;
  await connect();
  changed();
}

function reset() {
  attachLife.cancel();
  you = null;
  members = [];
  shares = new Map();
  inbox = [];
  comments = false;
  announced.clear();
  watchers.clear();
  queue.clear();
  holding.clear();
  queued = 0;
  clearTimeout(flushTimer);
  flushTimer = 0;
  attached = null;
  mirror.clear();
  remoteIds.clear();
  notes.clear();
  accessVersions.clear(); pendingAudience.clear();
}

const cleanName = (name: string) => {
  const n = normalizeName(name);
  if (!n) throw t("err.team.name");
  return n;
};

export async function create(name: string) {
  const n = cleanName(name);
  const base = relayOf(null);
  if (!base) throw t("err.team.noRelay");
  const { team, secret, member, credential } = await transport.create(base);
  await adopt({ relay: relayDraft || null, team, secret, member, credential, name: n });
}

export async function join(code: string, name: string) {
  const n = cleanName(name);
  const parsed = parseInvite(code);
  if (!parsed) throw t("err.team.badCode");
  const base = relayOf(null);
  if (!base) throw t("err.team.noRelay");
  const membership = await transport.enroll(base, parsed.team, parsed.secret);
  await adopt({ relay: relayDraft || null, team: parsed.team, secret: parsed.secret, ...membership, name: n });
}

export async function leave() {
  disconnect();
  reset();
  cfg = null;
  await invoke("team_config_set", { config: null });
  changed();
}

export async function setName(name: string) {
  if (!cfg || cfg.cloud) return;
  const n = cleanName(name);
  cfg = { ...cfg, name: n };
  await invoke("team_config_set", { config: cfg });
  send({ t: "me", name: n });
  changed();
}

export async function setRelay(url: string) {
  if (cfg?.cloud) return;
  const u = url.trim().replace(/\/+$/, "");
  if (u) wsUrl(u);
  relayDraft = u;
  if (cfg) {
    cfg = { ...cfg, relay: u || null };
    await invoke("team_config_set", { config: cfg });
    disconnect();
    attempt = 0;
    connect();
  }
  changed();
}

/* Owner announcements and forwarding. */

/// Retain the latest local board for announcements and reconnect recovery.
let lastBoard: Board | null = null;
/// Send serialized share descriptions only when they change.
const announced = new Map<string, string>();
/// Track local-tab viewers reported by the relay.
const watchers = new Map<string, string[]>();
/// Batch pending outgoing bytes per tab.
const queue = new Map<string, Segment[]>();
let queued = 0;
let flushTimer = 0;
/// Hold live output while its snapshot is being sent to preserve ordering.
const holding = new Map<string, number>();

/// Supply legacy geometry fields required by the protocol; conversation rendering ignores them.
const NO_SIZE: [number, number] = [80, 24];

function toShare(w: Workspace): Share {
  return {
    id: w.id,
    title: w.title,
    repo_name: w.repo_name,
    branch: w.branch,
    stage: w.stage,
    issue: w.issue ? { identifier: w.issue.identifier, title: w.issue.title, url: w.issue.url } : null,
    active: w.active,
    tabs: w.tabs.map((tab) => ({ id: tab.id, title: tab.title, status: tab.status, note: tab.note, tokens: tab.tokens })),
    sizes: Object.fromEntries(w.tabs.map((tab) => [tab.id, NO_SIZE])),
    audience: w.audience,
  };
}

/// Announce changed eligible local shares and withdraw archived, cleaned, or removed workspaces.
export function boardChanged(board: Board) {
  lastBoard = board;
  if (!cfg) return;
  const seen = new Set<string>();
  for (const w of board.workspaces) {
    if (!sharedHere(w) || w.remote) continue;
    if (w.archived || w.cleaned) {
      void invoke("set_shared", { id: w.id, shared: false });
      continue;
    }
    seen.add(w.id);
    const share = toShare(w);
    const json = JSON.stringify(share);
    if (announced.get(w.id) === json) continue;
    if (send({ t: "share", share })) announced.set(w.id, json);
  }
  for (const id of [...announced.keys()]) {
    if (seen.has(id)) continue;
    announced.delete(id);
    send({ t: "unshare", ws: id });
    for (const tab of [...watchers.keys()]) if (!tabOwnedBy(tab, seen)) watchers.delete(tab);
  }
}

const tabOwnedBy = (tab: string, ids: Set<string>) =>
  !!lastBoard?.workspaces.some((w) => ids.has(w.id) && w.tabs.some((t) => t.id === tab));

/// Require the tab to belong to a currently announced local workspace.
const mine = (tab: string) => tabOwnedBy(tab, new Set(announced.keys()));
function canReceive(tab: string, member: string): boolean {
  const w = lastBoard?.workspaces.find(w => w.tabs.some(t => t.id === tab));
  if (!w || !sharedHere(w) || w.archived || w.cleaned || !channel?.security.key(member)) return false;
  const audience = pendingAudience.has(w.id) ? pendingAudience.get(w.id) : w.audience;
  return audience !== false && (!audience || audience.includes(member));
}

/// Share with everyone using null, selected members using IDs, or stop using false. An empty audience also stops sharing.
export async function share(id: string, audience: string[] | null | false) {
  const on = audience !== false && (audience === null || audience.length > 0);
  if (on && !cfg) throw t("err.team.noRelay");
  if (pendingAudience.has(id)) throw t("err.team.encryption");
  const generation = connection;
  pendingAudience.set(id, on ? audience : false);
  accessVersions.set(id, (accessVersions.get(id) ?? 0) + 1);
  try {
    await invoke("set_shared", { id, shared: on, audience: on ? audience : null, team: on ? shareScope() : null });
    if (generation !== connection) return;
    // IPC completion can precede the board event. Presence must not reannounce
    // the old audience during that gap.
    if (lastBoard) lastBoard = { ...lastBoard, workspaces: lastBoard.workspaces.map(w => w.id === id
      ? { ...w, shared: on, audience: on ? audience as string[] | null : null, share_team: on ? shareScope() : null } : w) };
    const w = lastBoard?.workspaces.find(w => w.id === id);
    if (w && on) {
      const updated = { ...toShare(w), audience: audience as string[] | null };
      channel?.own(updated);
      if (phase === "online" && !await sendConfirmed({ t: "share", share: updated })) throw t("err.team.encryption");
    } else if (!on && phase === "online") {
      if (!await sendConfirmed({ t: "unshare", ws: id })) throw t("err.team.encryption");
    }
  } finally { if (generation === connection) pendingAudience.delete(id); }
}

const shareScope = () => cfg?.cloud ? `organization:${cfg.team}:${cfg.member}` : cfg ? `team:${cfg.team}` : null;
export const sharedHere = (workspace: Workspace) => !!cfg && workspace.shared &&
  (workspace.share_team ? workspace.share_team === shareScope() : !cfg.cloud);

export const isShared = (id: string) => announced.has(id);
export const watchersOf = (tab: string): string[] => (watchers.get(tab) ?? []).map(nameOf);

function watched(tab: string, who: string[], added: string[]) {
  if (!mine(tab)) return;
  who = who.filter(member => canReceive(tab, member));
  added = added.filter(member => canReceive(tab, member));
  if (who.length) watchers.set(tab, who);
  else watchers.delete(tab);
  for (const member of added) void snapshot(tab, member);
}

/// Resend full snapshots to existing viewers after owner reconnection.
function rewatch(watching: Watching) {
  watchers.clear();
  for (const tabs of Object.values(watching)) {
    for (const [tab, raw] of Object.entries(tabs)) {
      const who = raw.filter(member => canReceive(tab, member));
      if (!who.length || !mine(tab)) continue;
      watchers.set(tab, who);
      for (const member of who) void snapshot(tab, member);
    }
  }
}

/// Send local snapshots in chunks while holding live output; otherwise a viewer awaiting its first snapshot could discard later lines.
async function snapshot(tab: string, member: string) {
  if (!mine(tab) || !canReceive(tab, member)) return;
  const generation = connection;
  holding.set(tab, (holding.get(tab) ?? 0) + 1);
  try {
    const s = await invoke("chat_snapshot", { session: tab });
    if (generation !== connection || !mine(tab)) return;
    const parts = split(s.text);
    parts.forEach((part, i) => sendBinary(encodeSnapshot(tab, member, s.seq, enc.encode(part), i < parts.length - 1)));
  } catch {
    // If the session disappeared, the viewer opens its available mirror.
  } finally {
    if (generation === connection) {
      const left = (holding.get(tab) ?? 1) - 1;
      if (left > 0) holding.set(tab, left);
      else holding.delete(tab);
      flush();
    }
  }
}

/// Split at complete lines within relay frame size; send one empty chunk for an empty conversation.
function split(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > SNAPSHOT_PART) {
    const cut = rest.lastIndexOf("\n", SNAPSHOT_PART);
    const at = cut === -1 ? SNAPSHOT_PART : cut + 1;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  out.push(rest);
  return out;
}

/// Ignore output for unwatched tabs with a cheap map lookup.
function output(key: string, line: string, seq: number) {
  if (!watchers.has(key) || !mine(key)) return;
  const list = queue.get(key) ?? [];
  const bytes = enc.encode(line + "\n");
  list.push({ seq, bytes });
  queue.set(key, list);
  queued += bytes.length;
  if (queued >= FRAME_MAX) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, COALESCE);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  for (const [tab, segments] of queue) {
    if (holding.has(tab)) continue;
    queue.delete(tab);
    queued -= segments.reduce((n, s) => n + s.bytes.length, 0);
    if (!watchers.has(tab) || !mine(tab)) continue;
    sendBinary(encodeLive(tab, segments));
  }
  if (queue.size && !flushTimer) flushTimer = setTimeout(flush, COALESCE);
}

/// Revalidate remote input and control against announced local tabs before writing to a real process, even though the relay already filters it.
function typed(ws: string, tab: string, data: string, from: string) {
  if (!announced.has(ws) || !mine(tab)) return;
  const workspace = lastBoard?.workspaces.find(w => w.id === ws);
  const audience = pendingAudience.has(ws) ? pendingAudience.get(ws) : workspace?.audience;
  if (audience === false || (audience && !audience.includes(from)) || !channel?.security.key(from)) return;
  const parsed = remoteControl(data);
  if (parsed.recognized) {
    if (parsed.frame) void invoke("chat_control_remote", { session: tab, frame: parsed.frame }).catch(() => {});
    return;
  }
  const text = t("team.remotePrompt", { name: nameOf(from), text: data });
  void invoke("chat_send", { session: tab, text }).catch(() => {});
}

/* Remote shares. */

/// Prefix remote workspace IDs to avoid collisions with local board identities and accidental backend routing. Retain relay IDs separately.
const PREFIX = "@time:";
const remoteIds = new Map<string, { ws: string; owner: string }>();
const remoteId = (owner: string, ws: string) => `${PREFIX}${owner}/${ws}`;

/// The currently displayed remote tab, if any.
let attached: { ws: string; tab: string } | null = null;
/// Cache each viewed remote transcript through mirror.ts, which merges snapshot and live data independently of UI/network.
const mirror = new Map<string, Mirror>();
const attachLife = new AttachLifecycle();

/// Remote workspace entries exist only in frontend board state and carry remote metadata.
export function remotes(): Workspace[] {
  const out: Workspace[] = [];
  for (const s of shares.values()) {
    if (s.owner === you) continue;
    const id = remoteId(s.owner, s.id);
    remoteIds.set(id, { ws: s.id, owner: s.owner });
    out.push({
      id,
      title: s.title,
      project: "@time",
      repo: "",
      repo_name: s.repo_name,
      branch: s.branch,
      worktree: "",
      repos: [],
      stage: s.stage,
      archived: false,
      pinned: false,
      unread: false,
      // Relay shares do not identify the provider; remote UI must not derive behavior from a placeholder provider value.
      agent: "claude",
      model: "",
      effort: "",
      mcp: null,
      plugins: null,
      port: null,
      issue: s.issue ? { id: "", identifier: s.issue.identifier, title: s.issue.title, url: s.issue.url } : null,
      cleaned: false,
      shared: false,
      audience: null,
      // Remote shares are announced only after preparation is complete.
      preparing: false,
      failed: null,
      remote: { owner: s.owner, online: s.online },
      tabs: s.tabs.map((tab) => ({ ...tab })),
      active: s.active,
    });
  }
  return out;
}

/// Determine remoteness from the stable prefix, independent of transient share presence.
export const isRemote = (id: string) => id.startsWith(PREFIX);

/// Use the active remote attachment to route input; tab ID alone does not identify its owner.
export const attachedTab = () => attached?.tab ?? null;

/// Attach one remote tab at a time, releasing the previous watcher and waiting for its snapshot.
export async function attach(id: string, tab: string): Promise<{ bytes: Uint8Array } | null> {
  const found = remoteIds.get(id);
  const s = found && shares.get(found.ws);
  if (!s) throw t("err.team.noShare");
  attached = { ws: s.id, tab };
  // Invalidate old waits even when the new destination is already offline.
  if (!s.online) attachLife.cancel();
  if (s.online) {
    const ticket = attachLife.start(s.id, tab, SNAPSHOT_WAIT);
    if (!send({ t: "attach", ws: s.id, tab })) {
      attachLife.cancel();
      return attached?.ws === s.id && attached.tab === tab ? { bytes: mirrorOf(tab) } : null;
    }
    await ticket.wait;
    // Stop stale attachment continuations after detach or newer navigation, without touching ChatView.
    if (!attachLife.current(ticket) || attached?.ws !== s.id || attached.tab !== tab) return null;
  }
  return { bytes: mirrorOf(tab) };
}

export function detach() {
  attachLife.cancel();
  if (attached) send({ t: "detach" });
  attached = null;
}

/// Forward viewer input or JSON control to the online owner of the currently attached tab.
export function write(data: string) {
  if (!attached) return;
  const s = shares.get(attached.ws);
  if (!s) return;
  if (!s.online) {
    fail?.(t("err.team.offline"));
    return;
  }
  send({ t: "write", ws: s.id, tab: attached.tab, data });
}

function mirrorOf(tab: string): Uint8Array {
  return mirror.get(tab)?.bytes() ?? new Uint8Array(0);
}

function mirrorFor(tab: string): Mirror {
  let m = mirror.get(tab);
  if (!m) {
    m = new Mirror();
    mirror.set(tab, m);
  }
  return m;
}

function binary(data: ArrayBuffer) {
  const bin = decodeBinary(data);
  if (!bin) return;
  if (bin.kind === SNAPSHOT) {
    if (bin.to !== you) return;
    // Buffer intermediate snapshot chunks until completion.
    if (!mirrorFor(bin.tab).seed(bin.bytes, bin.seq, bin.more)) return;
    const completed = attachLife.completeTab(bin.tab);
    if (!completed && attached?.tab === bin.tab) {
      // An unsolicited recovery snapshot replaces the current view.
      guest.reset(bin.tab, mirrorOf(bin.tab));
    }
    return;
  }
  const m = mirrorFor(bin.tab);
  for (const seg of bin.segments) {
    const fresh = m.absorb(seg.seq, seg.bytes);
    if (fresh && attached?.tab === bin.tab) guest.live(bin.tab, fresh);
  }
}

/* Comments. */

/// Translate prefixed frontend workspace IDs back to relay identities.
const relayId = (id: string) => remoteIds.get(id)?.ws ?? id;

/// Request only currently known local announcements or remote shares to avoid missing-share errors.
const known = (ws: string) => announced.has(ws) || shares.has(ws);

/// Return cached workspace comments and request missing data; onChange delivers later results.
export function notesOf(id: string): Note[] {
  // Guard unannounced local workspaces at the request boundary, not only by hiding comment controls.
  if (!isRemote(id) && !announced.has(id)) return [];
  const ws = relayId(id);
  const have = notes.get(ws);
  if (have) return have;
  // Mark the cache before sending so a response cannot be overwritten by request initialization.
  notes.set(ws, []);
  if (!send({ t: "notes", ws })) notes.delete(ws);
  return [];
}

/// Send comments with optional quotes and member mentions. Resolve whether sending succeeded so offline input is not cleared.
export async function addNote(
  id: string,
  tab: string | null,
  anchor: string | null,
  text: string,
  mentions: string[],
  quote: string | null,
): Promise<boolean> {
  try { await includeMentioned(id, mentions); } catch { return false; }
  return sendConfirmed({ t: "note", ws: relayId(id), tab, anchor, text, mentions, quote });
}

async function includeMentioned(id: string, mentions: string[]) {
  // Expand an owned share's audience before mentioning a new member. Send its encrypted update before the comment on the same socket so the relay accepts the mention.
  const w = lastBoard?.workspaces.find((x) => x.id === id);
  if (w && sharedHere(w) && !w.remote && w.audience) {
    const missing = mentions.filter((m) => !w.audience!.includes(m));
    if (missing.length) {
      const grown: Share = { ...toShare(w), audience: [...w.audience, ...missing] };
      await share(id, grown.audience);
    }
  }
}

export async function replyNote(id: string, note: string, text: string, mentions: string[]): Promise<boolean> {
  try { await includeMentioned(id, mentions); } catch { return false; }
  return sendConfirmed({ t: "note_reply", ws: relayId(id), note, text, mentions });
}

export const resolveNote = (id: string, note: string) =>
  sendConfirmed({ t: "note_resolve", ws: relayId(id), note });

/// Count unresolved comments addressed to the current user.
export const inboxCount = () => inbox.length;

/// Opening does not resolve current relay threads; retain the legacy read fallback for older relays.
export function readInbox(id: string): { workspace: string; note: string; tab: string | null } | null {
  const item = inbox.find((i) => i.id === id);
  if (!item) return null;
  const owned = [...remoteIds].find(([, r]) => r.ws === item.ws);
  // Only legacy relays without resolution treat opening as completion.
  if (!comments) {
    send({ t: "inbox_read", id });
    inbox = inbox.filter((entry) => entry.id !== id);
    changed();
  }
  return { workspace: owned?.[0] ?? item.ws, note: item.id, tab: item.tab ?? null };
}

/// Inbox presentation combines comment, author, and workspace context.
export function inboxList(): { id: string; ws: string; author: string; ts: number; title: string; text: string }[] {
  return inbox.map((i) => {
    const note = notes.get(i.ws)?.find((n) => n.id === i.id);
    const share = shares.get(i.ws);
    return {
      id: i.id,
      ws: i.ws,
      author: nameOf(i.author),
      ts: i.ts,
      title: share?.title ?? "",
      text: i.text ?? note?.text ?? "",
    };
  });
}
