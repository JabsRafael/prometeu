import { describe, expect, it } from "vitest";
import { parseOrganizationAccess } from "./cloud";
import { empty, members, reduce } from "./logic";

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
  it("accepts companion devices linked to a listed person and rejects dangling or chained links", () => {
    const phone = { id: "phone1", name: "Alice (iPhone)", person: "member1" };
    const withPhone = { ...profile, members: [...profile.members, phone] };
    expect(parseOrganizationAccess(withPhone, "organization1", now)?.members).toContainEqual(phone);
    for (const members of [
      [...profile.members, { ...phone, person: "ghost" }],
      [...profile.members, { ...phone, person: "phone1" }],
      [...profile.members, phone, { id: "watch1", name: "Alice (Watch)", person: "phone1" }],
      [...profile.members, { ...phone, person: 42 }],
    ]) expect(parseOrganizationAccess({ ...profile, members }, "organization1", now)).toBeNull();
    const state = empty();
    reduce(state, { k: "roster", members: withPhone.members, now });
    expect(members(state).find(m => m.id === "phone1")).toEqual({ id: "phone1", name: "Alice (iPhone)", online: false, person: "member1" });
    reduce(state, { k: "roster", members: [...profile.members, { id: "phone1", name: "Alice (iPhone)" }], now: now + 1 });
    expect(members(state).find(m => m.id === "phone1")?.person).toBeUndefined();
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
