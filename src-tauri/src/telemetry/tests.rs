use super::*;
use serde_json::json;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("prometeu-telemetry-{}", id())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn scope() -> Scope {
    Scope {
        workspace_id: Some(id()),
        conversation_id: Some(id()),
        provider: Some("claude".into()),
        ..Scope::default()
    }
}
fn event(scope: &Scope, at: u64, fact: Fact) -> Event {
    let mut e = Event::new(scope.clone(), id(), fact);
    e.occurred_at = at;
    e
}
fn append(store: &mut Store, scope: &Scope, at: u64, fact: Fact) {
    store.append(&event(scope, at, fact)).unwrap();
}
#[test]
fn commits_deduplicates_reopens_and_preserves_future_versions() {
    let dir = Temp::new();
    let path = dir.0.join("telemetry.sqlite3");
    let mut store = Store::open(&path).unwrap();
    let e = event(&scope(), 10, Fact::ConversationCreated {});
    store.append(&e).unwrap();
    store.append(&e).unwrap();
    assert_eq!(
        serde_json::from_str::<Event>(&serde_json::to_string(&e).unwrap()).unwrap(),
        e
    );
    let mut conflict = e.clone();
    conflict.fact = Fact::WorkspaceArchived {};
    assert!(store.append(&conflict).is_err());
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.events(&Filter::default()).unwrap().len(), 1);
    store.db.pragma_update(None, "user_version", 99).unwrap();
    drop(store);
    assert!(Store::open(&path).is_err());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
#[test]
fn cohort_usage_overlap_and_incomplete_time_have_explicit_coverage() {
    let dir = Temp::new();
    let mut service = Service::new(dir.0.clone());
    let store = service.store.as_mut().unwrap();
    let mut scope = scope();
    scope.turn_id = Some(id());
    let main = id();
    let child = id();
    append(
        store,
        &scope,
        1000,
        Fact::TurnStarted {
            measurement: Measurement::default(),
        },
    );
    for execution_id in [&main, &child] {
        append(
            store,
            &scope,
            1000,
            Fact::ExecutionStarted {
                execution_id: execution_id.clone(),
            },
        );
        append(
            store,
            &scope,
            11000,
            Fact::ExecutionCompleted {
                execution_id: execution_id.clone(),
                elapsed_ms: 10000,
            },
        );
    }
    append(
        store,
        &scope,
        11000,
        Fact::TurnCompleted {
            outcome: Outcome::Ok,
            elapsed_ms: 10000,
            provider_duration_ms: None,
            measurement: Measurement {
                usage: Usage {
                    input_tokens: Some(10000),
                    cache_read_tokens: Some(8000),
                    output_tokens: Some(2000),
                    reasoning_tokens: Some(500),
                    ..Usage::default()
                },
                ..Measurement::default()
            },
        },
    );
    append(
        store,
        &scope,
        2000,
        Fact::ExecutionStarted { execution_id: id() },
    );
    let s = service.summary(&Filter::default()).unwrap();
    assert_eq!((s.input_tokens, s.output_tokens), (Some(10000), Some(2000)));
    assert_eq!(
        (s.execution_sum_ms, s.active_agent_ms),
        (Some(20000), Some(10000))
    );
    assert_eq!(s.incomplete_executions, 1);
    let s = service
        .summary(&Filter {
            from: Some(1000),
            to: Some(6000),
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(s.input_tokens, Some(10000));
    assert_eq!(s.active_agent_ms, Some(5000));
    let s = service
        .summary(&Filter {
            from: Some(6000),
            to: Some(11000),
            ..Filter::default()
        })
        .unwrap();
    assert_eq!(s.turns, 0);
    assert_eq!(s.input_tokens, None);
    assert_eq!(s.active_agent_ms, Some(5000));
}
#[test]
fn capture_keeps_requests_in_turn_and_children_outlive_completion_without_content() {
    let dir = Temp::new();
    let mut service = Service::new(dir.0.clone());
    let mut capture = Capture::default();
    let scope = scope();
    capture.accepted(&mut service, scope, Some("model-a".into()));
    capture.observe(&mut service,&json!({"type":"request.opened","requestId":"secret-request","kind":"approval","input":{"command":"PRIVATE COMMAND"}}));
    capture.observe(&mut service,&json!({"type":"request.closed","requestId":"secret-request","outcome":"allowed","answer":"PRIVATE ANSWER"}));
    capture.observe(&mut service,&json!({"type":"background.changed","tasks":[{"id":"secret-child","description":"PRIVATE TASK"}]}));
    capture.observe(
        &mut service,
        &json!({"type":"turn.completed","outcome":"ok","message":"PRIVATE RESPONSE"}),
    );
    capture.observe(
        &mut service,
        &json!({"type":"turn.completed","outcome":"ok"}),
    );
    let s = service.summary(&Filter::default()).unwrap();
    assert_eq!(s.turns, 1);
    assert_eq!(s.completed_turns, 1);
    assert_eq!(s.incomplete_executions, 1);
    assert_eq!(s.responded_waits, 1);
    capture.observe(
        &mut service,
        &json!({"type":"background.changed","tasks":[]}),
    );
    assert_eq!(
        service
            .summary(&Filter::default())
            .unwrap()
            .incomplete_executions,
        0
    );
    let export = service.export(&Filter::default()).unwrap();
    for secret in ["PRIVATE", "secret-child", "secret-request"] {
        assert!(!export.contains(secret));
    }
}
#[test]
fn erase_invalidates_late_callbacks_new_activity_starts_new_history() {
    let dir = Temp::new();
    let mut service = Service::new(dir.0.clone());
    let mut capture = Capture::default();
    let scope = scope();
    capture.accepted(&mut service, scope.clone(), None);
    service.clear().unwrap();
    capture.observe(
        &mut service,
        &json!({"type":"turn.completed","outcome":"ok"}),
    );
    capture.observe(
        &mut service,
        &json!({"type":"background.changed","tasks":[{"id":"late"}]}),
    );
    assert_eq!(service.summary(&Filter::default()).unwrap().events, 0);
    capture.accepted(&mut service, scope, None);
    assert_eq!(service.summary(&Filter::default()).unwrap().turns, 1);
    service.clear().unwrap();
    drop(service);
    let mut service = Service::new(dir.0.clone());
    assert_eq!(service.summary(&Filter::default()).unwrap().events, 0);
}
#[test]
fn missing_store_does_not_fail_capture_and_health_survives_restart() {
    let dir = Temp::new();
    paths::ensure_private_dir(&dir.0).unwrap();
    std::fs::create_dir(dir.0.join("telemetry.sqlite3")).unwrap();
    let mut service = Service::new(dir.0.clone());
    service.capture(0, &event(&scope(), 1, Fact::ConversationCreated {}));
    assert!(
        service
            .summary(&Filter::default())
            .unwrap()
            .health
            .unavailable
    );
    drop(service);
    let service = Service::new(dir.0.clone());
    assert!(service.health.failures >= 2);
}
#[test]
fn late_pr_relations_deduplicate_workspaces_and_do_not_allocate_cost() {
    let dir = Temp::new();
    let mut service = Service::new(dir.0.clone());
    let store = service.store.as_mut().unwrap();
    let mut scope = scope();
    scope.turn_id = Some(id());
    append(
        store,
        &scope,
        1,
        Fact::TurnStarted {
            measurement: Measurement::default(),
        },
    );
    let repo = id();
    for number in [1, 2] {
        append(
            store,
            &scope,
            20,
            Fact::PullRequestAssociated {
                repository_id: repo.clone(),
                branch_id: Some(id()),
                pull_request: number,
            },
        );
    }
    for number in [1, 2] {
        let s = service
            .summary(&Filter {
                repository_id: Some(repo.clone()),
                pull_request: Some(number),
                from: Some(0),
                to: Some(10),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(s.turns, 1);
    }
}
#[test]
fn malformed_measurements_and_payload_fields_are_rejected() {
    assert!(serde_json::from_value::<Usage>(json!({"prompt":"secret"})).is_err());
    let dir = Temp::new();
    let mut store = Store::open(&dir.0.join("telemetry.sqlite3")).unwrap();
    let mut scope = scope();
    scope.turn_id = Some(id());
    let mut measurement = Measurement::default();
    measurement.usage.cost_usd = Some(-1.);
    assert!(store
        .append(&event(&scope, 1, Fact::UsageObserved { measurement }))
        .is_err());
    scope.project_id = Some("/private/project".into());
    assert!(store
        .append(&event(&scope, 1, Fact::ConversationCreated {}))
        .is_err());
}
#[test]
fn legacy_board_identities_are_opaque_stable_and_distinct_from_paths() {
    let mut board = crate::state::Board::default();
    board.projects.push(crate::state::Project {
        id: "/private/repo".into(),
        path: "/private/repo".into(),
        name: "secret".into(),
    });
    board.prepare_telemetry_ids();
    let before = board.telemetry_ids.get("project", "/private/repo").unwrap();
    assert!(uuid::Uuid::parse_str(&before).is_ok());
    let mut restored: crate::state::Board =
        serde_json::from_str(&serde_json::to_string(&board).unwrap()).unwrap();
    restored.prepare_telemetry_ids();
    assert_eq!(
        restored.telemetry_ids.get("project", "/private/repo"),
        Some(before)
    );
}

#[test]
fn overlapping_input_preserves_unknown_attribution_instead_of_charging_the_new_message() {
    let dir = Temp::new();
    let mut service = Service::new(dir.0.clone());
    let mut capture = Capture::default();
    let scope = scope();
    capture.accepted(&mut service, scope.clone(), None);
    capture.accepted(&mut service, scope, None);
    capture.observe(
        &mut service,
        &json!({"type":"turn.completed","outcome":"ok"}),
    );
    let summary = service.summary(&Filter::default()).unwrap();
    assert_eq!(summary.turns, 2);
    assert_eq!(summary.completed_turns, 0);
    assert!(summary.health.failures > 0);
}

#[test]
fn request_cancellations_union_time_and_clock_jumps_are_not_measured_as_work() {
    let dir = Temp::new();
    let mut service = Service::new(dir.0.clone());
    let store = service.store.as_mut().unwrap();
    let scope = scope();
    for responded in [true, false] {
        let request = id();
        append(
            store,
            &scope,
            1000,
            Fact::HumanRequested {
                request_id: request.clone(),
                kind: RequestKind::Question,
            },
        );
        let fact = if responded {
            Fact::HumanReceived {
                request_id: request,
                elapsed_ms: 10000,
            }
        } else {
            Fact::HumanCancelled {
                request_id: request,
                elapsed_ms: 10000,
            }
        };
        append(store, &scope, 11000, fact);
    }
    let execution = id();
    append(
        store,
        &scope,
        1000,
        Fact::ExecutionStarted {
            execution_id: execution.clone(),
        },
    );
    append(
        store,
        &scope,
        12000,
        Fact::ExecutionCompleted {
            execution_id: execution,
            elapsed_ms: 1000,
        },
    );
    let summary = service.summary(&Filter::default()).unwrap();
    assert_eq!(summary.responded_waits, 1);
    assert_eq!(summary.cancelled_waits, 1);
    assert_eq!(summary.human_wait_ms, Some(10000));
    assert_eq!(summary.clock_anomalies, 1);
    assert_eq!(summary.active_agent_ms, None);
    let boundary = service
        .summary(&Filter {
            from: Some(11000),
            to: Some(15000),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(boundary.human_wait_ms, None);
}

#[test]
fn latest_snapshot_and_final_measurement_never_add_together_and_clear_removes_pages() {
    let dir = Temp::new();
    let path = dir.0.join("telemetry.sqlite3");
    let mut service = Service::new(dir.0.clone());
    let store = service.store.as_mut().unwrap();
    let mut scope = scope();
    scope.turn_id = Some(id());
    append(
        store,
        &scope,
        1,
        Fact::TurnStarted {
            measurement: Measurement::default(),
        },
    );
    let m = |input| Measurement {
        usage: Usage {
            input_tokens: Some(input),
            ..Default::default()
        },
        ..Default::default()
    };
    append(store, &scope, 2, Fact::UsageObserved { measurement: m(3) });
    append(store, &scope, 3, Fact::UsageObserved { measurement: m(4) });
    assert_eq!(
        service.summary(&Filter::default()).unwrap().input_tokens,
        Some(4)
    );
    append(
        service.store.as_mut().unwrap(),
        &scope,
        4,
        Fact::TurnCompleted {
            outcome: Outcome::Ok,
            elapsed_ms: 3,
            provider_duration_ms: None,
            measurement: m(5),
        },
    );
    assert_eq!(
        service.summary(&Filter::default()).unwrap().input_tokens,
        Some(5)
    );
    let before = service.page(&Filter::default(), None).unwrap();
    let needle = before.events[0].id.clone();
    let next = service
        .page(
            &Filter::default(),
            Some(query::Cursor {
                occurred_at: 1,
                sequence: before.events[0].sequence,
            }),
        )
        .unwrap();
    assert_eq!(next.events.len(), 3);
    service.clear().unwrap();
    assert!(!String::from_utf8_lossy(&std::fs::read(path).unwrap()).contains(&needle));
    assert!(!dir.0.join("telemetry.sqlite3-journal").exists());
    // A stale background callback is ignored even if it constructs its event after erasure.
    let event = event(&scope, 10, Fact::ConversationCreated {});
    service.capture(0, &event);
    assert!(service
        .page(&Filter::default(), None)
        .unwrap()
        .events
        .is_empty());
}

#[test]
fn export_is_private_without_changing_the_destination_directory() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Temp::new();
    std::fs::create_dir(&dir.0).unwrap();
    std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = dir.0.join("history.jsonl");
    std::fs::write(&path, "old").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    write_export(&path, "{\"exportVersion\":1}\n").unwrap();
    assert_eq!(
        std::fs::metadata(&dir.0).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\"exportVersion\":1}\n"
    );
    assert!(write_export(&dir.0.join("telemetry.sqlite3"), "{}").is_err());
}

#[test]
fn failed_commit_reports_coverage_and_a_later_retry_still_commits_once() {
    let dir = Temp::new();
    let mut service = Service::new(dir.0.clone());
    service
        .store
        .as_ref()
        .unwrap()
        .db
        .pragma_update(None, "query_only", true)
        .unwrap();
    let e = event(&scope(), 1, Fact::ConversationCreated {});
    service.capture(0, &e);
    let s = service.summary(&Filter::default()).unwrap();
    assert_eq!(s.events, 0);
    assert!(s.health.failures > 0);
    service
        .store
        .as_ref()
        .unwrap()
        .db
        .pragma_update(None, "query_only", false)
        .unwrap();
    service.capture(0, &e);
    service.capture(0, &e);
    assert_eq!(service.summary(&Filter::default()).unwrap().events, 1);
}
