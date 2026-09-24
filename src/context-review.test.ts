import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_BUDGET, MAX_SUGGESTIONS, QUESTIONS, appendToDraft, buildRequest, canReview, createReview, revisionOf, select,
  type ReviewContext, type ReviewView,
} from "./context-review";
import type { EvaluationAnswer, EvaluationPort, EvaluationRequest, EvaluationResult } from "./evaluation";
import { t, use } from "./i18n";

beforeEach(() => use("en"));

const project = { name: "billing", repositories: [], base: "main" };
const context = (draft: string, extra: Partial<ReviewContext> = {}): ReviewContext => ({ draft, issue: null, project, attachments: 0, ...extra });
const a = (id: string, outcome: string, confidence = 0.92): EvaluationAnswer => ({ id, outcome, confidence });

/// Synthetic evaluator answers; the service itself is never called by tests.
const clear = (kind = "feature"): EvaluationAnswer[] => [
  a("task_kind", kind),
  a("expected_behavior", "present"), a("reproduction", kind === "bug_fix" ? "present" : "not_applicable"),
  a("business_rule", "present"),
];

const csvIssue = {
  identifier: "BIL-42",
  title: "CSV import fails for existing customers",
  description: "Steps: upload customers.csv with a row whose email already exists. Result: 500 error. Expected: the import finishes.",
  state: "Todo", labels: ["bug"], team: "Billing", project: null,
};

/// The CSV example from the issue: reproduction is present in the issue, the rule for existing
/// customers is not. Asking for reproduction again would be a failure.
const csvAnswers: EvaluationAnswer[] = [
  a("task_kind", "bug_fix"),
  a("reproduction", "present", 0.95),
  a("expected_behavior", "present", 0.85),
  a("business_rule", "absent", 0.9), a("business_rule_resolver", "person", 0.88), a("business_rule_kind", "existing_records", 0.8),
];

describe("request building", () => {
  it("includes the complete issue, project metadata and uninspected attachments", () => {
    const request = buildRequest(context("Please fix it", { issue: csvIssue, attachments: 2, project: { name: "billing", repositories: ["web"], base: "main" } }));
    expect(request.questions).toBe(QUESTIONS);
    expect(request.context).toContain("Request draft:\nPlease fix it");
    expect(request.context).toContain("BIL-42 · CSV import fails for existing customers");
    expect(request.context).toContain(csvIssue.description);
    expect(request.context).toContain("Labels: bug");
    expect(request.context).toContain("Project: billing");
    expect(request.context).toContain("Additional repositories: web");
    expect(request.context).toContain("2 attachment(s) were added but their contents were not inspected");
  });

  it("never includes attachment paths", () => {
    const request = buildRequest(context("See the screenshot", { attachments: 1 }));
    expect(request.context).not.toMatch(/\/Users\/|\.png/);
  });

  it("stays within the byte budget with long drafts and issues in any language", () => {
    const long = "ação ".repeat(20_000);
    const request = buildRequest(context(long, { issue: { ...csvIssue, description: "descrição ".repeat(20_000) } }));
    expect(new TextEncoder().encode(request.context).length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(request.context).toContain("[…]");
    expect(request.context).toContain("Description:\ndescrição");
  });

  it("keeps questions closed and within the port bounds", () => {
    expect(QUESTIONS.length).toBeLessThanOrEqual(8);
    for (const question of QUESTIONS) {
      expect(question.id).toMatch(/^[a-z0-9_.]{1,40}$/);
      expect(question.outcomes.length).toBeGreaterThanOrEqual(2);
      expect(question.prompt.length).toBeLessThanOrEqual(600);
    }
  });

  it("does not review an empty launcher", () => {
    expect(canReview(context("  "))).toBe(false);
    expect(canReview(context("", { issue: csvIssue }))).toBe(true);
  });

  it("binds the revision to the draft and its context", () => {
    const base = revisionOf(context("Fix login"));
    expect(revisionOf(context("Fix login  "))).toBe(base);
    expect(revisionOf(context("Fix login!"))).not.toBe(base);
    expect(revisionOf(context("Fix login", { issue: csvIssue }))).not.toBe(base);
    expect(revisionOf(context("Fix login", { attachments: 1 }))).not.toBe(base);
    expect(revisionOf(context("Fix login", { project: { ...project, name: "web" } }))).not.toBe(base);
  });
});

describe("selection rules", () => {
  it("asks about the unresolved rule, not the reproduction already in the issue", () => {
    const selection = select(csvAnswers, context("", { issue: csvIssue }));
    expect(selection.suggestions).toEqual([{ topic: "business_rule", question: "review.q.rule.existingRecords" }]);
    expect(t(selection.suggestions[0].question)).toContain("skip, update or report");
  });

  it("uses the same catalog for a Portuguese request", () => {
    // "Corrigir a importação de CSV: clientes que já existem quebram a importação." with no rule.
    const selection = select(csvAnswers, context("Corrigir a importação de CSV: clientes que já existem quebram a importação."));
    use("pt-BR");
    expect(t(selection.suggestions[0].question)).toBe("O que fazer com registros que já existem: ignorar, atualizar ou relatar?");
  });

  it("produces no suggestion for short but complete requests (EN and PT)", () => {
    expect(select(clear(), context("Rename the Save button to Save draft"))).toEqual({ suggestions: [], reason: "clear" });
    expect(select(clear(), context("Trocar o texto do botão Salvar para Salvar rascunho"))).toEqual({ suggestions: [], reason: "clear" });
  });

  it("leaves intentionally investigative tasks open (EN and PT)", () => {
    const answers = [a("task_kind", "investigation"), a("business_rule", "absent"), a("business_rule_resolver", "person")];
    expect(select(answers, context("Investigate why the nightly build got slower")).reason).toBe("investigation");
    expect(select(answers, context("Investigar por que o build noturno ficou lento")).suggestions).toEqual([]);
  });

  it("abstains on low confidence anywhere in the chain", () => {
    expect(select([a("task_kind", "bug_fix", 0.5), ...csvAnswers.slice(1)], context("x")).reason).toBe("uncertain");
    expect(select([...csvAnswers.filter(x => x.id !== "business_rule"), a("business_rule", "absent", 0.7)], context("x")))
      .toEqual({ suggestions: [], reason: "uncertain" });
    expect(select([...csvAnswers.filter(x => x.id !== "business_rule_resolver"), a("business_rule_resolver", "person", 0.4)], context("x")).suggestions)
      .toEqual([]);
    expect(select([], context("x")).reason).toBe("uncertain");
  });

  it("does not ask the person for facts the agent can investigate", () => {
    const answers = [a("task_kind", "bug_fix"), a("reproduction", "absent"), a("reproduction_resolver", "agent"),
      a("expected_behavior", "present"), a("business_rule", "not_applicable")];
    expect(select(answers, context("The export button crashes"))).toEqual({ suggestions: [], reason: "clear" });
  });

  it("treats attachments as uninspected rather than proof of absence", () => {
    const answers = [a("task_kind", "bug_fix"), a("reproduction", "absent"), a("reproduction_resolver", "person"),
      a("expected_behavior", "present"), a("business_rule", "present")];
    expect(select(answers, context("Bug in the screenshot", { attachments: 1 })).suggestions).toEqual([]);
    expect(select(answers, context("Bug in the screenshot")).suggestions).toEqual([{ topic: "reproduction", question: "review.q.reproduction" }]);
    const uninspected = [a("task_kind", "feature"), a("expected_behavior", "uninspected"), a("expected_behavior_resolver", "person"), a("business_rule", "present")];
    expect(select(uninspected, context("Implement the design in the attached mockup", { attachments: 1 })).suggestions).toEqual([]);
  });

  it("keeps bug fixes and features in scope only", () => {
    expect(select([a("task_kind", "other")], context("Write release notes")).reason).toBe("out_of_scope");
  });

  it("orders consequential gaps and chooses a generic rule question when its kind is unsure", () => {
    const answers = [a("task_kind", "feature"), a("expected_behavior", "ambiguous", 0.85), a("expected_behavior_resolver", "person"),
      a("business_rule", "absent"), a("business_rule_resolver", "person"), a("business_rule_kind", "permissions", 0.3)];
    expect(select(answers, context("Add an export")).suggestions.map(s => s.question))
      .toEqual(["review.q.rule.other", "review.q.expected.feature"]);
  });
});

describe("draft changes", () => {
  it("appends an editable block without rewriting the request", () => {
    expect(appendToDraft("Fix the import  \n", "Answer: ")).toBe("Fix the import\n\nAnswer: ");
    expect(appendToDraft("", "Answer: ")).toBe("Answer: ");
  });
});

/// A port whose replies the test resolves explicitly, to exercise late responses.
function deferredPort() {
  const calls: { request: EvaluationRequest; resolve: (r: EvaluationResult) => void; reject: (e: unknown) => void }[] = [];
  const port: EvaluationPort = { evaluate: request => new Promise((resolve, reject) => calls.push({ request, resolve, reject })) };
  return { port, calls };
}

function session(port: EvaluationPort, enabled = { on: true }, epoch = { n: 0 }) {
  const views: ReviewView[] = [];
  const review = createReview({ port, epoch: () => epoch.n, available: () => enabled.on, changed: view => views.push(view) });
  return { review, views, enabled, epoch };
}

const threeGaps = [a("task_kind", "bug_fix"),
  a("business_rule", "absent"), a("business_rule_resolver", "person"), a("business_rule_kind", "existing_records"),
  a("reproduction", "absent"), a("reproduction_resolver", "person"),
  a("expected_behavior", "ambiguous", 0.9), a("expected_behavior_resolver", "person")];

describe("review session", () => {
  it("makes zero calls while disabled or for an empty draft", async () => {
    const { port, calls } = deferredPort();
    const { review } = session(port, { on: false });
    await review.review(context("Fix login"));
    expect(calls).toHaveLength(0);
    const enabled = session(port);
    await enabled.review.review(context(""));
    expect(calls).toHaveLength(0);
  });

  it("shows one suggestion at a time and at most two per unchanged request", async () => {
    const { port, calls } = deferredPort();
    const { review } = session(port);
    const pending = review.review(context("Fix the import"));
    expect(review.view()).toEqual({ phase: "evaluating" });
    calls[0].resolve({ answers: threeGaps });
    await pending;
    expect(review.view()).toMatchObject({ phase: "suggesting", index: 1, suggestion: { topic: "business_rule" } });
    review.dismiss();
    expect(review.view()).toMatchObject({ phase: "suggesting", index: 2, suggestion: { topic: "reproduction" } });
    review.dismiss();
    expect(review.view()).toEqual({ phase: "none", reason: "limit" });
    expect(MAX_SUGGESTIONS).toBe(2);
    // Reviewing the same unchanged request again reuses the result and keeps dismissals.
    await review.review(context("Fix the import"));
    expect(calls).toHaveLength(1);
    expect(review.view()).toEqual({ phase: "none", reason: "limit" });
  });

  it("ignores a late response after the draft changed", async () => {
    const { port, calls } = deferredPort();
    const { review } = session(port);
    const pending = review.review(context("Fix the import"));
    review.update(context("Fix the import for existing customers: skip them"));
    expect(review.view()).toEqual({ phase: "idle" });
    calls[0].resolve({ answers: threeGaps });
    await pending;
    expect(review.view()).toEqual({ phase: "idle" });
  });

  it("ignores late responses after closing, disabling or replacing the key", async () => {
    for (const change of ["close", "disable", "epoch"] as const) {
      const { port, calls } = deferredPort();
      const s = session(port);
      const pending = s.review.review(context("Fix the import"));
      if (change === "close") s.review.close();
      if (change === "disable") s.enabled.on = false;
      if (change === "epoch") s.epoch.n++;
      calls[0].resolve({ answers: threeGaps });
      await pending;
      expect(s.views.some(view => view.phase === "suggesting")).toBe(false);
    }
  });

  it("clears a shown suggestion when the context changes and forgets results on reset", async () => {
    const { port, calls } = deferredPort();
    const { review } = session(port);
    const first = review.review(context("Fix the import"));
    calls[0].resolve({ answers: threeGaps });
    await first;
    review.update(context("Fix the import", { attachments: 1 }));
    expect(review.view()).toEqual({ phase: "idle" });
    review.reset();
    const second = review.review(context("Fix the import"));
    expect(calls).toHaveLength(2);
    calls[1].resolve({ answers: clear("bug_fix") });
    await second;
    expect(review.view()).toEqual({ phase: "none", reason: "clear" });
  });

  it("reports service failures without producing a suggestion", async () => {
    for (const [error, code] of [
      ['i18n:{"code":"err.evaluation.auth"}', "auth"],
      ['i18n:{"code":"err.evaluation.rate_limited"}', "rate_limited"],
      ['i18n:{"code":"err.evaluation.unavailable"}', "unavailable"],
      ['i18n:{"code":"err.evaluation.malformed"}', "malformed"],
      [new Error("socket closed"), "unavailable"],
    ] as const) {
      const { port, calls } = deferredPort();
      const { review } = session(port);
      const pending = review.review(context("Fix the import"));
      calls[0].reject(error);
      await pending;
      expect(review.view()).toEqual({ phase: "failed", code });
    }
  });

  it("treats a backend stale result as silent", async () => {
    const { port, calls } = deferredPort();
    const { review } = session(port);
    const pending = review.review(context("Fix the import"));
    calls[0].reject('i18n:{"code":"err.evaluation.stale"}');
    await pending;
    expect(review.view()).toEqual({ phase: "idle" });
  });

  it("returns the chosen suggestion for an answer and invalidates the current result", async () => {
    const { port, calls } = deferredPort();
    const { review } = session(port);
    const pending = review.review(context("Fix the import"));
    calls[0].resolve({ answers: csvAnswers });
    await pending;
    expect(review.resolve()).toEqual({ topic: "business_rule", question: "review.q.rule.existingRecords" });
    expect(review.view()).toEqual({ phase: "idle" });
    expect(review.resolve()).toBeNull();
  });

  it("sends only the explicit review, never on typing", async () => {
    const { port, calls } = deferredPort();
    const { review } = session(port);
    for (const draft of ["F", "Fi", "Fix", "Fix it"]) review.update(context(draft));
    expect(calls).toHaveLength(0);
  });
});
