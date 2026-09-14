import { isId, MEMBERS_MAX } from "../relay/src/protocol";
import { generateIdentity, validateIdentity, validatePublicKey, type Identity } from "./team-crypto";

type Scope = { identity: Identity; peers: Record<string, string>; receipts?: Record<string, number>; clock?: number;
  sequence?: number; shares?: Record<string, { owner: string; key: string; revision: number; message: string }> };
type State = { version: 1; scopes: Record<string, unknown> };
type Write = (state: unknown) => Promise<void>;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const dictionary = <T>(source: Record<string, T> = {}): Record<string, T> => Object.assign(Object.create(null), source);

/** Identity pins survive tickets, reconnects and organization switches; a member's new key replaces the pin. */
export class TeamSecurity {
  readonly identity: Identity;
  private observed = new Map<string, string | undefined>();
  private self: string | undefined;
  private pending = Promise.resolve();

  private constructor(private scope: string, private state: State, private current: Scope, private write: Write) {
    this.identity = current.identity;
  }

  static async load(scope: string, read: () => Promise<unknown>, write: Write): Promise<TeamSecurity> {
    if (!scope || typeof scope !== "string") throw new Error("Invalid identity scope");
    const value = await read();
    if (value != null && (!record(value) || value.version !== 1 || !record(value.scopes))) {
      throw new Error("Invalid identity storage");
    }
    const state: State = { version: 1, scopes: dictionary(value == null ? {} : (value as State).scopes) };
    let current: Scope;
    if (Object.prototype.hasOwnProperty.call(state.scopes, scope)) {
      const saved = state.scopes[scope];
      if (!record(saved) || !record(saved.peers) || Object.keys(saved.peers).length > MEMBERS_MAX) {
        throw new Error("Invalid identity storage");
      }
      const identity = await validateIdentity(saved.identity);
      const peers = dictionary<string>();
      for (const [member, key] of Object.entries(saved.peers)) {
        if (!isId(member) || typeof key !== "string") throw new Error("Invalid identity peer");
        await validatePublicKey(key);
        peers[member] = key;
      }
      if (saved.receipts !== undefined && (!record(saved.receipts) || Object.keys(saved.receipts).length > 4096 ||
        Object.entries(saved.receipts).some(([id, at]) => !isId(id) || !Number.isSafeInteger(at)))) throw new Error("Invalid replay storage");
      if (saved.clock !== undefined && (!Number.isSafeInteger(saved.clock) || Number(saved.clock) < 0)) throw new Error("Invalid replay clock");
      if (saved.sequence !== undefined && (!Number.isSafeInteger(saved.sequence) || Number(saved.sequence) < 0)) throw new Error("Invalid share sequence");
      if (saved.shares !== undefined && (!record(saved.shares) || Object.keys(saved.shares).length > 4096 ||
        Object.entries(saved.shares).some(([ws, v]) => !isId(ws) || !record(v) || !isId(v.owner) || !isId(v.message) ||
          typeof v.key !== "string" || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1))) throw new Error("Invalid share history");
      current = { identity, peers, receipts: saved.receipts as Scope["receipts"], clock: saved.clock as number | undefined,
        sequence: saved.sequence as number | undefined, shares: saved.shares as Scope["shares"] };
    } else {
      current = { identity: await generateIdentity(), peers: dictionary() };
      state.scopes[scope] = current;
      await write(state);
    }
    return new TeamSecurity(scope, state, current, write);
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private async save(peers: Record<string, string>): Promise<void> {
    await this.commit({ ...this.current, identity: this.identity, peers });
  }

  private async commit(current: Scope): Promise<void> {
    const state: State = { version: 1, scopes: dictionary(this.state.scopes) };
    state.scopes[this.scope] = current;
    await this.write(state);
    this.state = state;
    this.current = current;
  }

  async nextRevision(): Promise<number> {
    let revision = 0;
    await this.serialize(async () => {
      revision = (this.current.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Share sequence exhausted");
      await this.commit({ ...this.current, sequence: revision });
    });
    return revision;
  }

  observeShare(ws: string, owner: string, key: string, revision: number, message: string): Promise<void> {
    return this.serialize(async () => {
      if (!isId(ws) || !isId(owner) || !isId(message) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid share revision");
      const previous = this.current.shares?.[ws];
      if (previous && (previous.owner !== owner || (previous.key === key &&
        (revision < previous.revision || (revision === previous.revision && message !== previous.message))))) throw new Error("Repeated or replaced share");
      if (previous?.key === key && previous.revision === revision) return;
      const shares = dictionary(this.current.shares);
      shares[ws] = { owner, key, revision, message };
      if (Object.keys(shares).length > 4096) throw new Error("Share history full");
      await this.commit({ ...this.current, shares });
    });
  }

  observe(members: Array<{ id: string; key?: string }>, self: string): Promise<void> {
    return this.serialize(async () => {
      // Clear availability before async validation so a bad directory cannot leave
      // previously available keys usable while this observation is being checked.
      this.observed.clear();
      if (!isId(self) || !Array.isArray(members) || members.length > MEMBERS_MAX
        || (this.self !== undefined && this.self !== self)) throw new Error("Invalid identity directory");
      this.self = self;
      const observed = new Map<string, string | undefined>();
      for (const member of members) {
        if (!member || !isId(member.id) || observed.has(member.id)
          || (member.key !== undefined && typeof member.key !== "string")) throw new Error("Invalid identity directory");
        if (member.key !== undefined) await validatePublicKey(member.key);
        observed.set(member.id, member.key);
      }
      this.observed = observed;
      const peers = dictionary(this.current.peers);
      let added = false;
      for (const [member, key] of observed) {
        if (key === undefined) continue;
        if (member === self) {
          if (key !== this.identity.publicKey) throw new Error("Own identity key changed");
          continue;
        }
        // A reinstall or a new pairing arrives as a different key. Adopt it silently instead of blocking
        // content until someone compares codes by hand; the trade-off is in ADR 0042.
        if (peers[member] !== key) {
          peers[member] = key;
          added = true;
        }
      }
      if (Object.keys(peers).length > MEMBERS_MAX) throw new Error("Too many identity peers");
      if (added) await this.save(peers);
    });
  }

  key(member: string): string | undefined {
    const pinned = member === this.self ? this.identity.publicKey : this.current.peers[member];
    return pinned !== undefined && this.observed.get(member) === pinned ? pinned : undefined;
  }

  /** Persist before executing remote input; clock rollback fails closed. */
  consume(id: string, expires: number): Promise<void> {
    return this.serialize(async () => {
      const now = Date.now();
      if (!isId(id) || !Number.isSafeInteger(expires) || expires < now || expires > now + 120_000 ||
        now < (this.current.clock ?? 0) || this.current.receipts?.[id] !== undefined) throw new Error("Expired or repeated input");
      const receipts = Object.fromEntries(Object.entries(this.current.receipts ?? {}).filter(([, at]) => at >= now));
      if (Object.keys(receipts).length >= 4096) throw new Error("Replay storage full");
      receipts[id] = expires;
      const current = { ...this.current, receipts, clock: now };
      await this.commit(current);
    });
  }
}
