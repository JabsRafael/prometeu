# Antigravity stream fixtures

`tool.ndjson`, `resume.ndjson`, and `interrupted.ndjson` were recorded from the
installed Antigravity CLI 1.2.7 on 2026-09-19, using its existing external account
in an empty temporary workspace. Only the conversation identity and working
directory were replaced with fixture constants.

The first prompt requested only `echo AGY_TOOL_OK` and a matching reply. The
second process resumed that native conversation and recalled the marker. The
third received SIGINT after its first step. Version 1.2.7 returned `ERROR` with
`error: "interrupted"`, which the adapter maps to an interrupted turn.

`canonical-events.json` runs all three live recordings through the adapter for
cross-language V1 validation. Each recording uses a fresh adapter instance, with
the original session identity shared by the tool and resume recordings. The
independent interrupted conversation receives a distinct fixture identity. Event
timestamps and turn durations are zeroed for deterministic comparison. Regenerate it with
`PROMETEU_UPDATE_ANTIGRAVITY_FIXTURE=1 cargo test antigravity::tests::canonical_events_match_cross_language_fixture`
from `src-tauri/`.

`permission-denied.ndjson` minimizes a real 1.2.7 recording in a dedicated empty
diagnostic directory, with the application's default launch flags. It preserves
the `ERROR` tool state and `SUCCESS` result with nonempty `denied_actions`. The
command was not executed; no denial was bypassed. These events must produce a
visible permission failure rather than an empty successful turn.
