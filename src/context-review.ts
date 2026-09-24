import { errorCode, type EvaluationAnswer, type EvaluationErrorCode, type EvaluationPort, type EvaluationQuestion, type EvaluationRequest } from "./evaluation";
import type { Key } from "./i18n";

/// Missing-context review: the first consumer of the evaluation port (ADR 0058). It builds a bounded
/// context from what the launcher really has, asks closed questions, and applies conservative
/// application rules to choose at most one localized question at a time. It never generates or
/// rewrites text; DOM, IPC and vendor payloads stay outside this module.

export type Topic = "business_rule" | "expected_behavior" | "reproduction";
export type Presence = "present" | "ambiguous" | "absent" | "uninspected" | "not_applicable";
export type TaskKind = "bug_fix" | "feature" | "investigation" | "other";
export type Resolver = "person" | "agent" | "unclear";
export type RuleKind = "existing_records" | "permissions" | "failure_handling" | "scope" | "other";

export type ReviewIssue = {
  identifier: string;
  title: string;
  description: string | null;
  state?: string;
  labels?: string[];
  team?: string;
  project?: string | null;
};

/// Everything the check may use. Attachments are only counted: their contents were not inspected.
export type ReviewContext = {
  draft: string;
  issue: ReviewIssue | null;
  project: { name: string; repositories: string[]; base: string };
  attachments: number;
};

/// Conservative thresholds; they are hypotheses to validate, not guarantees of the service.
export const THRESHOLDS = { kind: 0.7, presence: 0.8, resolver: 0.7, ruleKind: 0.6 } as const;
export const MAX_SUGGESTIONS = 2;
/// Leave headroom under the backend's 24 KiB bound for the section labels.
export const CONTEXT_BUDGET = 22 * 1024;

const PRESENCE: Presence[] = ["present", "ambiguous", "absent", "uninspected", "not_applicable"];
const RESOLVER: Resolver[] = ["person", "agent", "unclear"];
const PRESENCE_GUIDE =
  "Answer present if the context states it clearly, ambiguous if it is stated but open to materially different readings, " +
  "absent if the inspected context does not contain it, uninspected if it may be in an attachment or source that was not inspected, " +
  "and not_applicable if this task does not need it. A short request can be complete.";
const RESOLVER_GUIDE =
  "Answer person if only the requester can decide it (a product or business decision), agent if a coding agent can reasonably " +
  "find it by reading the repository, running the code or reading logs, and unclear otherwise.";

/// Closed questions sent to the evaluator. Their text is an instruction to the service, not UI copy.
export const QUESTIONS: EvaluationQuestion[] = [
  { id: "task_kind", outcomes: ["bug_fix", "feature", "investigation", "other"],
    prompt: "What kind of task is the request? investigation means the requester asks to explore, diagnose or propose options and may leave questions open." },
  { id: "expected_behavior", outcomes: PRESENCE,
    prompt: `Is the expected behavior after the change clear enough to implement? ${PRESENCE_GUIDE}` },
  { id: "expected_behavior_resolver", outcomes: RESOLVER,
    prompt: `If the expected behavior is missing or ambiguous, who can resolve it? ${RESOLVER_GUIDE}` },
  { id: "reproduction", outcomes: PRESENCE,
    prompt: `For a reported problem, is the information needed to locate or reproduce it available (steps, data, environment, error)? ${PRESENCE_GUIDE}` },
  { id: "reproduction_resolver", outcomes: RESOLVER,
    prompt: `If reproduction information is missing or ambiguous, who can resolve it? ${RESOLVER_GUIDE}` },
  { id: "business_rule", outcomes: PRESENCE,
    prompt: `Is every business rule or acceptance condition that would materially change the implementation resolved? Answer absent or ambiguous only for an unresolved rule. ${PRESENCE_GUIDE}` },
  { id: "business_rule_resolver", outcomes: RESOLVER,
    prompt: `If a business rule is unresolved, who can resolve it? ${RESOLVER_GUIDE}` },
  { id: "business_rule_kind", outcomes: ["existing_records", "permissions", "failure_handling", "scope", "other"],
    prompt: "If a business rule is unresolved, what does it concern? existing_records: how to treat records or data that already exist; permissions: who may do it; failure_handling: what happens on invalid input or failure; scope: which cases, limits or variants are included." },
];

/// App-owned, localized question catalog. The evaluator only selects among these entries.
export const CATALOG = {
  expected_behavior: { bug_fix: "review.q.expected.bug", feature: "review.q.expected.feature" },
  reproduction: "review.q.reproduction",
  business_rule: {
    existing_records: "review.q.rule.existingRecords",
    permissions: "review.q.rule.permissions",
    failure_handling: "review.q.rule.failureHandling",
    scope: "review.q.rule.scope",
    other: "review.q.rule.other",
  },
} as const satisfies Record<Topic, unknown>;

export type Suggestion = { topic: Topic; question: Key };
export type NoneReason = "clear" | "investigation" | "out_of_scope" | "uncertain";
export type Selection = { suggestions: Suggestion[]; reason: NoneReason | null };

const encoder = new TextEncoder();
const size = (text: string) => encoder.encode(text).length;

/// Per-field caps for metadata, in UTF-8 bytes. Their sum stays far below the budget, so the draft
/// and the description always keep most of it and the final context never exceeds it.
export const METADATA_LIMITS = { field: 256, title: 1024, list: 1024 } as const;

/// Clip to a UTF-8 byte budget without splitting a character.
function clip(text: string, budget: number, marker = "\n[…]"): string {
  if (size(text) <= budget) return text;
  if (budget <= size(marker)) return "";
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(text.slice(0, middle)) + size(marker) <= budget) low = middle; else high = middle - 1;
  }
  // Never end on a lone high surrogate.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return text.slice(0, low) + marker;
}

const line = (text: string, budget: number = METADATA_LIMITS.field) => clip(text.replace(/\s+/g, " ").trim(), budget, "…");
const list = (items: string[]) => line(items.map(item => item.trim()).filter(Boolean).join(", "), METADATA_LIMITS.list);

/// A review needs the person's own words or an attached issue; an empty launcher makes no call.
export const canReview = (context: ReviewContext) => !!context.draft.trim() || !!context.issue;

/// Everything the evaluator sees, normalized once. `buildRequest` renders only these fields and
/// `revisionOf` hashes all of them, so a change the request would carry is always a new revision.
function material(context: ReviewContext) {
  const issue = context.issue;
  return {
    draft: context.draft.trim(),
    issue: issue
      ? {
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description?.trim() || null,
          state: issue.state ?? null,
          team: issue.team ?? null,
          project: issue.project ?? null,
          labels: issue.labels ?? [],
        }
      : null,
    project: { name: context.project.name, repositories: context.project.repositories, base: context.project.base },
    attachments: context.attachments,
  };
}

/// The relevant revision of the draft and its context. Results for another revision are stale.
export function revisionOf(context: ReviewContext): string {
  return JSON.stringify(material(context));
}

/// Build the bounded context. The complete issue is included so information already present there is
/// not requested again; metadata fields are capped, and the draft and issue description share the
/// rest of the budget, the draft first.
export function buildRequest(context: ReviewContext): EvaluationRequest {
  const { draft: draftText, issue, project: meta, attachments } = material(context);
  const project = [
    "Project metadata:",
    `Project: ${line(meta.name)}`,
    meta.repositories.length ? `Additional repositories: ${list(meta.repositories)}` : "",
    meta.base ? `Base branch: ${line(meta.base)}` : "",
  ].filter(Boolean).join("\n");
  const uninspected = attachments
    ? `Uninspected sources: ${attachments} attachment(s) were added but their contents were not inspected. ` +
      "Do not treat information as absent if it could be in them; answer uninspected instead."
    : "Uninspected sources: none.";
  const fixed = size(project) + size(uninspected) + 256;
  const issueHead = issue
    ? [
        `Originating issue (complete): ${line(issue.identifier)} · ${line(issue.title, METADATA_LIMITS.title)}`,
        issue.state ? `State: ${line(issue.state)}` : "",
        issue.team ? `Team: ${line(issue.team)}` : "",
        issue.project ? `Issue project: ${line(issue.project)}` : "",
        issue.labels.length ? `Labels: ${list(issue.labels)}` : "",
      ].filter(Boolean).join("\n")
    : "";
  const remaining = CONTEXT_BUDGET - fixed - size(issueHead);
  const draftBudget = issue?.description ? Math.max(Math.floor(remaining / 2), remaining - size(issue.description)) : remaining;
  const draft = clip(draftText, draftBudget);
  const description = issue?.description ? clip(issue.description, remaining - size(draft)) : "";
  const sections = [
    `Request draft:\n${draft || "(empty; the issue is the request)"}`,
    issue ? [issueHead, description ? `Description:\n${description}` : "Description: (none)"].join("\n") : "Originating issue: none.",
    project,
    uninspected,
  ];
  return { context: sections.join("\n\n"), questions: QUESTIONS };
}

/// Apply the application rules to the evaluator's answers. Only confident, consequential gaps that
/// need the person's decision become suggestions, in order of consequence.
export function select(answers: EvaluationAnswer[], context: ReviewContext): Selection {
  const by = new Map(answers.map(answer => [answer.id, answer]));
  const kind = by.get("task_kind");
  if (!kind || kind.confidence < THRESHOLDS.kind) return { suggestions: [], reason: "uncertain" };
  const task = kind.outcome as TaskKind;
  if (task === "investigation") return { suggestions: [], reason: "investigation" };
  if (task !== "bug_fix" && task !== "feature") return { suggestions: [], reason: "out_of_scope" };
  const topics: Topic[] = task === "bug_fix"
    ? ["business_rule", "reproduction", "expected_behavior"]
    : ["business_rule", "expected_behavior"];
  let uncertain = false;
  const suggestions: Suggestion[] = [];
  for (const topic of topics) {
    const presence = by.get(topic);
    if (!presence) { uncertain = true; continue; }
    if (presence.outcome !== "absent" && presence.outcome !== "ambiguous") continue;
    if (presence.confidence < THRESHOLDS.presence) { uncertain = true; continue; }
    // A screenshot or log may hold reproduction details; an uninspected source is not proof of absence.
    if (topic === "reproduction" && context.attachments > 0) continue;
    const resolver = by.get(`${topic}_resolver`);
    if (!resolver || resolver.confidence < THRESHOLDS.resolver) { uncertain = true; continue; }
    // Routine repository facts are left to the coding agent.
    if (resolver.outcome !== "person") continue;
    suggestions.push({ topic, question: questionFor(topic, task, by.get("business_rule_kind")) });
  }
  return { suggestions, reason: suggestions.length ? null : uncertain ? "uncertain" : "clear" };
}

function questionFor(topic: Topic, task: "bug_fix" | "feature", ruleKind: EvaluationAnswer | undefined): Key {
  if (topic === "reproduction") return CATALOG.reproduction;
  if (topic === "expected_behavior") return CATALOG.expected_behavior[task];
  const kind = ruleKind && ruleKind.confidence >= THRESHOLDS.ruleKind && ruleKind.outcome in CATALOG.business_rule
    ? ruleKind.outcome as RuleKind
    : "other";
  return CATALOG.business_rule[kind];
}

/// Append an explicit, editable block to the draft; the original text is never rewritten.
export function appendToDraft(draft: string, block: string): string {
  const base = draft.replace(/\s+$/, "");
  return base ? `${base}\n\n${block}` : block;
}

export type ReviewView =
  | { phase: "idle" }
  | { phase: "evaluating" }
  | { phase: "suggesting"; suggestion: Suggestion; index: number }
  | { phase: "none"; reason: NoneReason | "limit" }
  | { phase: "failed"; code: EvaluationErrorCode };

type Cached = { revision: string; suggestions: Suggestion[]; reason: NoneReason | null };

/// Review session for one open launcher. It binds every call to the draft revision and the
/// configuration epoch, shows one suggestion at a time, at most two per unchanged request, and
/// remembers dismissals for that revision. Late results after edits, closing, submission or a
/// configuration change are ignored.
export function createReview(options: {
  port: EvaluationPort;
  epoch: () => number;
  available: () => boolean;
  changed: (view: ReviewView) => void;
}) {
  let view: ReviewView = { phase: "idle" };
  let ticket = 0;
  let closed = false;
  let cache: Cached | null = null;
  /// Topics already shown or dismissed, per revision.
  const shown = new Map<string, Set<Topic>>();
  const dismissed = new Map<string, Set<Topic>>();
  let revision = "";

  const set = (next: ReviewView) => { view = next; options.changed(view); };
  const seen = (map: Map<string, Set<Topic>>, key: string) => {
    let topics = map.get(key);
    if (!topics) map.set(key, topics = new Set());
    return topics;
  };

  const advance = () => {
    if (!cache) return;
    const already = seen(shown, cache.revision);
    const blocked = dismissed.get(cache.revision) ?? new Set<Topic>();
    const next = cache.suggestions.find(suggestion => !already.has(suggestion.topic) && !blocked.has(suggestion.topic));
    if (!next || already.size >= MAX_SUGGESTIONS) {
      set({ phase: "none", reason: cache.suggestions.length ? "limit" : cache.reason ?? "clear" });
      return;
    }
    already.add(next.topic);
    set({ phase: "suggesting", suggestion: next, index: already.size });
  };

  return {
    view: () => view,

    /// Explicit action only. An unchanged revision reuses its result instead of calling again.
    async review(context: ReviewContext) {
      if (closed || !options.available() || !canReview(context)) return;
      if (view.phase === "evaluating" || view.phase === "suggesting") return;
      revision = revisionOf(context);
      if (cache?.revision === revision) { advance(); return; }
      const mine = ++ticket;
      const epoch = options.epoch();
      const bound = revision;
      set({ phase: "evaluating" });
      let result: Awaited<ReturnType<EvaluationPort["evaluate"]>> | null = null;
      let failure: EvaluationErrorCode | null = null;
      try { result = await options.port.evaluate(buildRequest(context)); }
      catch (error) { failure = errorCode(error); }
      if (closed || mine !== ticket) return;
      if (bound !== revision || epoch !== options.epoch() || !options.available()) { set({ phase: "idle" }); return; }
      if (failure || !result) {
        if (failure === "stale") { set({ phase: "idle" }); return; }
        set({ phase: "failed", code: failure ?? "malformed" });
        return;
      }
      const selection = select(result.answers, context);
      cache = { revision: bound, suggestions: selection.suggestions, reason: selection.reason };
      advance();
    },

    /// Suppress the current suggestion for this revision and offer the next one, if any.
    dismiss() {
      if (view.phase !== "suggesting" || !cache) return;
      seen(dismissed, cache.revision).add(view.suggestion.topic);
      advance();
    },

    /// Answer and investigate change the draft, which makes the current result stale.
    resolve() {
      if (view.phase !== "suggesting") return null;
      const suggestion = view.suggestion;
      ticket++;
      set({ phase: "idle" });
      return suggestion;
    },

    /// Call on every draft or context change; pending and shown results for another revision go away.
    update(context: ReviewContext) {
      const next = revisionOf(context);
      if (next === revision) return;
      revision = next;
      ticket++;
      if (view.phase !== "idle") set({ phase: "idle" });
    },

    /// Hide a finished outcome or a failure; the draft is untouched.
    clear() {
      if (view.phase === "none" || view.phase === "failed") set({ phase: "idle" });
    },

    /// Configuration changes, submission and closing invalidate everything in flight.
    reset() {
      ticket++;
      cache = null;
      shown.clear();
      if (view.phase !== "idle") set({ phase: "idle" });
    },

    close() {
      closed = true;
      ticket++;
    },
  };
}

export type Review = ReturnType<typeof createReview>;
