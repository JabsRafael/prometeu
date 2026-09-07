import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Board, Workspace } from "./types";
import type { Down, Up } from "../relay/src/protocol";

const fake = vi.hoisted(() => ({
  config: null as unknown,
  invoke: vi.fn(),
  organizations: [{ id: "organization1", slug: "one", name: "One", member: "membership1", role: "owner" },
    { id: "organization2", slug: "two", name: "Two", member: "membership2", role: "member" }],
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
const account = { user: { id: "user1", name: "Alice", email: "alice@example.com" }, origin: "https://cloud.test", offline: false };

class Socket {
  sent: (Up | Uint8Array)[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBuffer | Uint8Array) { if (data !== "ping") this.sent.push(typeof data === "string" ? JSON.parse(data) : new Uint8Array(data as ArrayBuffer)); }
  close() { this.onclose?.(); }
  says(frame: Down) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  welcome(member: string, watching = {}) { this.onopen?.(); this.says({ t: "welcome", you: member, members: [], shares: [], inbox: [], watching }); }
}
let team: typeof import("./team");
let sockets: Socket[];
let urls: string[];
const workspace = (scope?: string): Workspace => ({ id: "workspace1", title: "Work", repo_name: "repo", branch: "main", stage: "", issue: null,
  active: "tab1", tabs: [{ id: "tab1", title: "Chat", status: "pronta", note: null, tokens: null }], shared: true,
  share_team: scope, audience: null, remote: null, archived: false, cleaned: false } as Workspace);
const board = (work: Workspace): Board => ({ workspaces: [work], projects: [], stages: [] });

beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); fake.config = null; sockets = []; urls = [];
  fake.invoke.mockReset().mockImplementation(async (command: string, args: any) => {
    if (command === "team_config") return { config: fake.config, default_name: "Alice" };
    if (command === "team_config_set") { fake.config = args.config; return; }
    if (command === "cloud_organizations") return { ...account, organizations: fake.organizations };
    if (command === "cloud_relay_ticket") return `wss://relay.test/organization/${args.organization}?ticket=${"t".repeat(43)}&p=3`;
    if (command === "chat_snapshot") return { text: "private transcript", seq: 1 };
  });
  team = await import("./team");
  team.useTransport({ needsRelay: true, create: vi.fn(), enroll: vi.fn(), socket: url => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket; } });
  await team.init(); await team.refreshOrganizations(account);
});
afterEach(async () => { await team.leave(); vi.useRealTimers(); });

it("selects accepted organizations without enrolling and keeps the desktop bearer outside sockets and storage", async () => {
  expect(sockets).toHaveLength(0);
  await team.selectOrganization("organization1"); await vi.advanceTimersByTimeAsync(0);
  expect(urls[0]).toContain("/organization/organization1?ticket=");
  expect(fake.config).toMatchObject({ team: "organization1", member: "membership1", credential: "", secret: "" });
  expect(JSON.stringify(fake.config)).not.toContain("ticket");
  sockets[0].welcome("membership1");
  expect(team.status().phase).toBe("online");
  await team.share("workspace1", null);
  expect(fake.invoke).toHaveBeenCalledWith("set_shared", { id: "workspace1", shared: true, audience: null, team: "organization:organization1:membership1" }, undefined);
});

it("does not publish legacy shares, another organization's shares or stale transcript responses after switching", async () => {
  await team.selectOrganization("organization1"); await vi.advanceTimersByTimeAsync(0);
  sockets[0].welcome("membership1");
  team.boardChanged(board(workspace()));
  expect(sockets[0].sent).toEqual([]);
  const work = workspace("organization:organization1:membership1");
  team.boardChanged(board(work));
  expect(sockets[0].sent).toContainEqual(expect.objectContaining({ t: "share" }));
  let finish!: (value: { text: string; seq: number }) => void;
  fake.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  sockets[0].says({ t: "watch", ws: work.id, tab: "tab1", members: ["guest"], added: ["guest"] });
  await team.selectOrganization("organization2"); await vi.advanceTimersByTimeAsync(0);
  sockets[1].welcome("membership2", { workspace1: { tab1: ["guest"] } });
  finish({ text: "private transcript", seq: 1 }); await vi.advanceTimersByTimeAsync(0);
  expect(sockets[1].sent).toEqual([]);
  expect(team.sharedHere(work)).toBe(false);
  sockets[0].says({ t: "presence", members: [{ id: "leak", name: "Old", online: true }] });
  expect(team.status().members).toEqual([]);
});

it("discards a pending relay ticket after logout and drops revoked membership", async () => {
  let finish!: (value: string) => void;
  const previous = fake.invoke.getMockImplementation()!;
  fake.invoke.mockImplementation((command, args) => command === "cloud_relay_ticket" ? new Promise(resolve => { finish = resolve; }) : previous(command, args));
  await team.selectOrganization("organization1");
  await team.refreshOrganizations({ ...account, user: null });
  finish("wss://relay.test/organization/organization1?ticket=old"); await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(0);
  expect(team.status().config).toBeNull();
  fake.invoke.mockImplementation(previous);
  await team.refreshOrganizations(account); await team.selectOrganization("organization1"); await vi.advanceTimersByTimeAsync(0);
  sockets[0].welcome("membership1");
  fake.invoke.mockImplementation((command, args) => command === "cloud_organizations" ? Promise.resolve({ ...account, organizations: [] }) : previous(command, args));
  await team.refreshOrganizations(account);
  expect(team.status().config).toBeNull();
  expect(team.status().phase).toBe("off");
});
