# Optional context evaluation and missing-context review

Status: current contract. Decision in
[ADR 0058](../decisions/0058-optional-context-evaluation.md).

## Responsibilities

| Part | Location | Owns |
| --- | --- | --- |
| evaluation port | `src-tauri/src/evaluation.rs`, `src/evaluation.ts` | closed request/answer types, bounds, validation, error codes, configuration generation |
| TypeSafe adapter and credential | `src-tauri/src/typesafe.rs` | private key file, enable flag, HTTP transport, retries, vendor validation and error translation |
| desktop shell | `src/typesafe.ts`, `src/typesafe-settings.ts` | IPC port, status store, Settings controls |
| missing-context review | `src/context-review.ts` (rules), `src/context-review-view.ts` (launcher panel) | context building, closed questions, selection, localized question catalog, stale-result binding |

The review imports only the port types. It never sees a vendor payload, the key
or the HTTP status. The timeline, the relay and the conversation protocol are
unchanged; the integration is independent of Claude, Codex and Antigravity and
of the Prometeu Cloud account.

## Credential and enablement lifecycle

- The integration is **disabled** by default. A missing file, an old
  installation, or a file without `enabled: true` and a key is disabled.
- Saving a key stores it and **does not** enable evaluation. Replacing a key
  keeps the current choice. Removing the key deletes the file, so a later key
  starts disabled again.
- Enabling requires a saved key (`err.evaluation.noKey` otherwise).
- Every save, replacement, removal, enable or disable bumps an in-memory
  configuration generation. An evaluation that started under another generation
  returns `stale`, and the adapter stops retrying. The frontend also bumps its
  own epoch and discards pending and shown results.
- An unreadable or invalid file keeps the integration disabled and reports
  `err.evaluation.storage` as a visible configuration problem in Settings; it
  never blocks normal work.

## Persistence

`<root>/typesafe.json`, private (`0600` in a `0700` directory) with the atomic
writer used by other credentials:

```json
{ "version": 1, "enabled": false, "key": "…" }
```

All fields default when absent. The file is additive: older app versions ignore
it, and it never enters the board, `team.json`, the relay, Cloud catalogs,
transcripts or the repository. Rolling back leaves it inert.

## IPC

| Command | Arguments | Result |
| --- | --- | --- |
| `typesafe_status` | none | `{ configured, enabled, problem }` |
| `typesafe_save_key` | `{ key }` | the same status |
| `typesafe_remove_key` | none | the same status |
| `typesafe_set_enabled` | `{ enabled }` | the same status |
| `context_evaluate` | `{ request: { context, questions: [{ id, prompt, outcomes }] } }` | `{ answers: [{ id, outcome, confidence }] }` |

The status never contains the key or any part of it. `problem` is `null` or an
i18n-coded error. Failures reject with `i18n:{"code":"err.evaluation.<code>"}`:

| Code | Meaning |
| --- | --- |
| `disabled` | integration off or without a key; no call was made |
| `auth` | the service rejected the key (401/403) |
| `rate_limited` | 429 after bounded retries |
| `unavailable` | offline, timeout or 5xx after bounded retries, or any other status |
| `malformed` | response outside the closed questions, invalid confidence, oversized or not JSON |
| `invalid` | request outside the port bounds, or refused by the service (400/413/422) |
| `stale` | configuration changed during the call; the frontend ignores it silently |
| `key`, `noKey`, `storage` | configuration errors from the Settings commands |

Bounds checked before any network call: context up to 24 KiB of UTF-8, one to
eight questions, identifiers and outcomes of lowercase letters, digits, `_` and
`.` up to 40 bytes, two to eight unique outcomes per question, prompts up to
600 bytes. Answers must name a requested question and one of its outcomes, at
most once, with a finite confidence between 0 and 1; omitted questions mean
abstention.

`context_evaluate` runs on a blocking worker thread, never on the UI or async
threads. The browser mock implements all five commands without a key or any
network: it stores only whether a key was configured, and answers with a local
deterministic fake. `mock:typesafeFail` simulates a failure code.

## Transport

- Origin `https://api.typesafe.ai`, overridable with `PROMETEU_TYPESAFE_URL`
  (HTTPS, or HTTP on loopback; no credentials, query or redirects).
- 5-second connect and 15-second request timeouts; responses above 256 KiB are
  malformed.
- At most three attempts for network errors, 429 and 500/502/503/504, with
  400 ms and 1.2 s backoff or a `Retry-After` of at most three seconds.
- The key travels only as `Authorization: Bearer`. Response bodies, URLs and
  library errors are discarded; errors carry only the application code.

### Assumed TypeSafe wire shape

The public documentation was unreachable when the adapter was written, so this
shape is an assumption isolated in `typesafe.rs::wire` and must be verified
against the live service before release:

```http
POST /v1/evaluate
Authorization: Bearer <key>

{ "state": "<context>", "questions": [{ "id": "task_kind", "question": "…", "type": "enum", "options": ["bug_fix", "…"] }] }
```

```json
{ "answers": [{ "id": "task_kind", "value": "bug_fix", "confidence": 0.93 }] }
```

A `null` value is an abstention. Any other shape is `malformed`.

## External data flow

Only after the person chooses **Review request** with the integration enabled,
the local backend sends the context directly to TypeSafe with the person's key.
Typing never sends anything. Settings and the action's tooltip state this. The
context contains:

- the draft, in the person's own language;
- the complete originating Linear issue when attached: identifier, title,
  description, state, team, project and labels;
- the project name, additional repository names and the base branch;
- the number of attachments, marked as **uninspected**. Attachment paths and
  contents are never sent.

The draft and the issue share a byte budget, the draft first; clipped text ends
with a marker.

## Missing-context review

Scope: new local workspaces, bug fixes and features. The request asks one call
with eight closed questions: the task kind; for expected behavior, reproduction
information and unresolved business rules, a state among `present`,
`ambiguous`, `absent`, `uninspected` and `not_applicable` and who can resolve a
gap (`person`, `agent`, `unclear`); and what an unresolved rule concerns.

Selection rules, in `src/context-review.ts`:

- task kind below 0.7 confidence: no suggestion (`uncertain`); `investigation`:
  no suggestion; anything other than a bug fix or feature: no suggestion;
- a topic becomes a suggestion only when `absent` or `ambiguous` with at least
  0.8 confidence **and** resolvable only by the person with at least 0.7;
- `present`, `not_applicable` and `uninspected` never produce a question;
  reproduction is never requested while attachments exist;
- order of consequence: business rule, reproduction (bug fixes), expected
  behavior;
- the question text comes from the localized `review.q.*` catalog; the rule
  question uses its subtype only above 0.6 confidence, otherwise a generic one.

Interaction:

- one suggestion at a time, at most two per unchanged request; reviewing an
  unchanged request again reuses the result without another call;
- **Answer** appends a localized, editable `Clarification: … / Answer:` block to
  the draft; **Let the agent investigate** appends an explicit instruction;
  **Dismiss** suppresses that topic for the same draft and context and shows the
  next one;
- every result is bound to the draft/context revision (draft, issue, project,
  additional repositories, base branch and attachment count) and to the
  configuration epoch. Edits, issue or project changes, submission, closing the
  launcher, disabling, and key replacement or removal discard pending and shown
  results;
- **Create workspace** stays available during evaluation, after dismissal and
  on failure; drafts and attachments are preserved.

## Tests

- `src-tauri/src/evaluation.rs`: disabled path makes no call, bounds, closed-set
  validation, stale generation.
- `src-tauri/src/typesafe.rs`: disabled defaults and old files, saving does not
  enable, removal disables, `0600` file, key absent from status and errors, the
  assumed wire shape, 401/429/503/offline/timeout/non-JSON translation, bounded
  retries, recovery after a transient failure, cancellation between retries.
- `src/context-review.test.ts`: context building with the complete issue and
  uninspected attachments, byte budget, English and Portuguese examples including
  short, investigative, attachment and low-confidence negatives, the CSV example,
  one-at-a-time and two-per-request limits, dismissal, stale responses after
  edits, closing, disabling and key changes, failures and explicit-only calls.
- `src-tauri/tests/mock.rs`: command parity across Rust, the typed map and the
  mock.

No browser scenario is added: the behavior is covered by unit tests, and the
panel reuses shared controls without a new keyboard or focus model (see the
[E2E scope policy](../operations/development.md#e2e-scope)).
