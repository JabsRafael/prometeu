import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { icon } from "./icons";
import { current as locale, t } from "./i18n";
import { openNotes } from "./news";
import { $, h, template } from "./util";
import { linux } from "./platform";

/// Check a public update manifest, verify downloaded bundles with the embedded minisign key, and replace the app after explicit download/restart actions. Sidebar shows actionable updates; Settings always shows version and check status. Both derive from one phase.

/// Check periodically because the app can remain open all day.
const EVERY = 60 * 60 * 1000;

/// After requesting restart, detect when the app remains running long enough to indicate failure.
const STUCK = 8_000;

/// Keep only updater-plugin fields needed by the UI and controlled test updates.
export type Found = Pick<Update, "version" | "body" | "downloadAndInstall">;

/// A single phase determines button behavior and avoids contradictory flags, including a stale busy flag blocking restart. After bootstrap, expose a meaningful current status.
export type Phase =
  | { at: "quiet" }
  | { at: "checking" }
  | { at: "fresh"; when: string }
  | { at: "failed"; why: string }
  | { at: "found"; update: Found }
  | { at: "downloading"; update: Found; got: number; total: number }
  | { at: "ready"; version: string }
  | { at: "restarting"; version: string };

/// Derive both views from one phase: the footer shows actionable states, while Settings also explains idle and failed checks.
export type View = {
  text: string;
  title: string;
  disabled: boolean;
  /// Use the filled button when its action restarts the app.
  ready: boolean;
  footer: boolean;
  note: string;
  tone: "plain" | "ok" | "bad";
  /// Expose manifest release notes before downloading so the user can review the update.
  notes?: { version: string; body: string };
};

/// Idle phases share the manual check action.
const ask = () => ({
  text: t("update.ask"),
  title: t("update.ask.title"),
  disabled: false,
  ready: false,
  footer: false,
});

export function view(phase: Phase): View {
  switch (phase.at) {
    case "quiet":
      return { ...ask(), note: "", tone: "plain" };
    case "checking":
      return {
        text: t("update.checking"),
        title: "",
        disabled: true,
        ready: false,
        footer: false,
        note: t("update.checking.note"),
        tone: "plain",
      };
    case "fresh":
      // An up-to-date app needs no success color; reserve emphasis for meaningful events.
      return { ...ask(), note: t("update.fresh", { when: phase.when }), tone: "plain" };
    case "failed":
      return { ...ask(), note: t("update.failedCheck", { why: phase.why }), tone: "bad" };
    case "found":
      return {
        text: t("update.found", { version: phase.update.version }),
        title: phase.update.body?.trim() || t("update.found.title", { version: phase.update.version }),
        disabled: false,
        ready: false,
        footer: true,
        note: t("update.found.note", { version: phase.update.version }),
        tone: "plain",
        notes: phase.update.body?.trim()
          ? { version: phase.update.version, body: phase.update.body }
          : undefined,
      };
    case "downloading":
      return {
        text: phase.total
          ? t("update.downloading", { pct: Math.round((phase.got / phase.total) * 100) })
          : t("update.downloading.unknown"),
        title: "",
        disabled: true,
        ready: false,
        footer: true,
        note: t("update.downloading.note", { version: phase.update.version }),
        tone: "plain",
      };
    case "ready":
      return {
        text: t("update.ready"),
        title: t("update.ready.title", { version: phase.version }),
        disabled: false,
        ready: true,
        footer: true,
        note: t("update.ready.note", { version: phase.version }),
        tone: "ok",
      };
    case "restarting":
      return {
        text: t("update.restarting"),
        title: "",
        disabled: true,
        ready: true,
        footer: true,
        note: t("update.restarting"),
        tone: "plain",
      };
  }
}

/// Inject update checking, restart, clock, rendering, and notices for deterministic tests.
export type Io = {
  check: () => Promise<Found | null>;
  relaunch: () => Promise<void>;
  clock: () => string;
  show: (view: View) => void;
  say: (text: string, isError?: boolean) => void;
};

/// Allow another check while an offered update waits; a newer release may replace it before download.
const idle = (phase: Phase) => phase.at === "quiet" || phase.at === "fresh" || phase.at === "failed" || phase.at === "found";

export function updater(io: Io) {
  let phase: Phase = { at: "quiet" };
  const go = (next: Phase) => {
    phase = next;
    io.show(view(phase));
  };
  /// Read the current phase after await; TypeScript cannot see asynchronous mutations performed by go().
  const at = () => phase.at;

  /// Distinguish manual checks from scheduled checks so only requested failures replace the visible status.
  const look = async (mine = false) => {
    if (!idle(phase)) return;
    const before = phase;
    go({ at: "checking" });
    let update: Found | null;
    try {
      update = await io.check();
    } catch (err) {
      // Background network or manifest failures do not require a user-facing alert.
      go(mine ? { at: "failed", why: String(err) } : before);
      return;
    }
    if (at() !== "checking") return;
    go(update ? { at: "found", update } : { at: "fresh", when: io.clock() });
  };

  const download = async (update: Found) => {
    go({ at: "downloading", update, got: 0, total: 0 });
    const progress = (e: DownloadEvent) => {
      if (phase.at !== "downloading") return;
      if (e.event === "Started") go({ ...phase, total: e.data.contentLength ?? 0 });
      if (e.event === "Progress") go({ ...phase, got: phase.got + e.data.chunkLength });
    };
    try {
      await update.downloadAndInstall(progress);
      go({ at: "ready", version: update.version });
    } catch (err) {
      // A manual check must report its error.
      go({ at: "found", update });
      io.say(t("update.failed", { err: String(err) }), true);
    }
  };

  // The bundle on disk is ready; explicit restart replaces the running app and ends its processes.
  const restart = async (version: string) => {
    go({ at: "restarting", version });
    try {
      await io.relaunch();
    } catch (err) {
      go({ at: "ready", version });
      io.say(t("update.restartFailed", { err: String(err) }), true);
      return;
    }
    await new Promise((r) => setTimeout(r, STUCK));
    if (phase.at !== "restarting") return;
    go({ at: "ready", version });
    io.say(t("update.stuck", { version }), true);
  };

  const click = async () => {
    if (phase.at === "found") {
      await look(true);
      if (phase.at === "found") await download(phase.update);
    } else if (phase.at === "ready") await restart(phase.version);
    else if (idle(phase)) await look(true);
  };

  return { look, click, phase: () => phase };
}

/* Both UI entry points. */

let now: View = view({ at: "quiet" });
let ver = "";
let row: HTMLElement | null = null;
let click: () => void = () => {};

const clock = () => new Date().toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

function dress(btn: HTMLButtonElement) {
  btn.textContent = now.text;
  btn.title = now.title;
  btn.disabled = now.disabled;
}

function paintRow(el: HTMLElement) {
  const note = el.querySelector(".txt > span")!;
  note.textContent = now.note;
  note.className = now.tone === "plain" ? "" : now.tone;
  const link = el.querySelector(".notes") as HTMLButtonElement;
  link.hidden = !now.notes;
  link.textContent = t("update.notes");
  const btn = el.querySelector(".go") as HTMLButtonElement;
  dress(btn);
  btn.className = now.ready ? "pri md go" : "outline md go";
}

function paint() {
  const foot = $("update") as HTMLButtonElement;
  foot.hidden = !now.footer;
  dress(foot);
  foot.classList.toggle("ready", now.ready);

  // Settings rebuilds its page on visits; avoid updating detached rows.
  if (!row?.isConnected) row = null;
  else paintRow(row);
}

/// Create a Settings row that updates itself while connected.
export function settingsRow(): HTMLElement {
  const el = template(
    "div",
    "setrow",
    `<span class="glyph">${icon("rotate", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  el.querySelector("b")!.textContent = ver ? `Prometeu ${ver}` : "Prometeu";
  // Offer release notes before download, only when notes exist.
  const link = h("button", "ghost md notes") as HTMLButtonElement;
  link.addEventListener("click", () => {
    if (now.notes) openNotes(now.notes.version, now.notes.body);
  });
  const btn = h("button", "outline md go") as HTMLButtonElement;
  btn.addEventListener("click", () => click());
  el.querySelector(".act")!.append(link, btn);
  // Initialize new rows from the already-current phase.
  paintRow(el);
  row = el;
  return el;
}

export async function init(say: Io["say"]) {
  ver = `v${await getVersion()}`;
  $("ver").textContent = ver;
  // The package manager updates Linux installs.
  if (linux) {
    now = { ...view({ at: "quiet" }), disabled: true, note: t("update.linux"), tone: "plain" };
    paint();
    return;
  }

  const up = updater({
    check,
    relaunch,
    clock,
    say,
    show: (next) => {
      now = next;
      paint();
    },
  });
  click = () => void up.click();

  $("update").addEventListener("click", () => click());
  // Check during startup so the first Settings status reflects an actual result.
  void up.look();
  setInterval(() => void up.look(), EVERY);
}
