import { describe, expect, it } from "vitest";
import { parseOrganizationAccess } from "./cloud";
import { empty, reduce } from "./logic";

describe("organization relay authorization", () => {
  const now = 100_000;
  const profile = { organization: "organization1", member: "member1", name: "Alice", expires_at: now + 60_000,
    members: [{ id: "member1", name: "Alice" }, { id: "member2", name: "Bob" }] };
  it("binds identity, roster and bounded lease to the requested organization", () => {
    expect(parseOrganizationAccess(profile, "organization1", now)).toEqual(profile);
    for (const value of [null, {}, { ...profile, member: "outsider" }, { ...profile, name: "Impersonated" },
      { ...profile, expires_at: now },
      { ...profile, members: [...profile.members, profile.members[0]] }, { ...profile, members: [{ id: "__proto__", name: "Alice" }] }]) {
      expect(parseOrganizationAccess(value, "organization1", now)).toBeNull();
    }
    expect(parseOrganizationAccess(profile, "organization2", now)).toBeNull();
    expect(parseOrganizationAccess({ ...profile, expires_at: now + 120_000 }, "organization1", now)?.expires_at).toBe(now + 60_000);
  });
  it("reconciles offline members and removes revoked sockets and their shared workspaces", () => {
    const state = empty();
    reduce(state, { k: "roster", members: profile.members, now });
    reduce(state, { k: "open", member: "member1", sock: "socket1", name: "Alice", now });
    reduce(state, { k: "open", member: "member2", sock: "socket2", name: "Bob", now });
    state.shares.set("workspace", { owner: "member2", online: true, share: { id: "workspace", title: "Private", repo_name: "r", branch: "b", stage: "", issue: null, active: null, tabs: [], sizes: {}, audience: null } });
    const effects = reduce(state, { k: "roster", members: [profile.members[0]], now: now + 1 });
    expect([...state.members.keys()]).toEqual(["member1"]);
    expect([...state.socks.keys()]).toEqual(["socket1"]);
    expect(state.shares.size).toBe(0);
    expect(effects).toContainEqual({ e: "del", key: "share:workspace" });
    expect(effects).toContainEqual({ e: "send", sock: "socket1", frame: { t: "unshare", ws: "workspace" } });
  });
});
