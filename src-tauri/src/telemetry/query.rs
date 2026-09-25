use super::*;
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub workspace_id: Option<String>,
    pub repository_id: Option<String>,
    pub pull_request: Option<u64>,
}
impl Filter {
    fn validate(&self) -> Result<()> {
        if self.from.unwrap_or(0) >= self.to.unwrap_or(i64::MAX as u64)
            || self.to.is_some_and(|n| n > i64::MAX as u64)
            || self.repository_id.is_some() != self.pull_request.is_some()
            || self
                .pull_request
                .is_some_and(|n| n == 0 || n > i64::MAX as u64)
            || [&self.workspace_id, &self.repository_id].iter().any(|s| {
                s.as_ref()
                    .is_some_and(|v| uuid::Uuid::parse_str(v).is_err())
            })
        {
            return Err("err.telemetry.filter".into());
        }
        Ok(())
    }
    fn includes(&self, at: u64) -> bool {
        at >= self.from.unwrap_or(0) && at < self.to.unwrap_or(i64::MAX as u64)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub occurred_at: u64,
    pub sequence: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub events: Vec<Event>,
    pub next: Option<Cursor>,
    pub health: Health,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub first_recorded_at: Option<u64>,
    pub last_recorded_at: Option<u64>,
    pub events: u64,
    pub turns: u64,
    pub completed_turns: u64,
    pub partial_turns: u64,
    pub measured_turns: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub incomplete_executions: u64,
    pub complete_executions: u64,
    pub clock_anomalies: u64,
    pub execution_sum_ms: Option<u64>,
    pub active_agent_ms: Option<u64>,
    pub responded_waits: u64,
    pub cancelled_waits: u64,
    pub incomplete_waits: u64,
    pub human_wait_ms: Option<u64>,
    pub workspace_ids: Vec<String>,
    pub health: Health,
}
pub(super) fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    let kind: String = r.get(7)?;
    let payload: String = r.get(13)?;
    let fact=serde_json::from_value(serde_json::json!({"type":kind,"payload":serde_json::from_str::<serde_json::Value>(&payload).map_err(|e| rusqlite::Error::FromSqlConversionFailure(13,rusqlite::types::Type::Text,Box::new(e)))?})).map_err(|e| rusqlite::Error::FromSqlConversionFailure(13,rusqlite::types::Type::Text,Box::new(e)))?;
    Ok(Event {
        sequence: r.get::<_, i64>(0)? as u64,
        id: r.get(1)?,
        occurrence_key: r.get(2)?,
        schema_version: r.get(3)?,
        occurred_at: r.get::<_, i64>(4)? as u64,
        recorded_at: r.get::<_, i64>(5)? as u64,
        category: r.get(6)?,
        scope: Scope {
            project_id: r.get(8)?,
            workspace_id: r.get(9)?,
            conversation_id: r.get(10)?,
            turn_id: r.get(11)?,
            provider: r.get(12)?,
        },
        fact,
    })
}
impl Store {
    pub(super) fn events(&self, filter: &Filter) -> Result<Vec<Event>> {
        filter.validate()?;
        let mut statement=self.db.prepare("SELECT * FROM events WHERE (?1 IS NULL OR workspace_id=?1)
            AND (?2 IS NULL OR workspace_id IN (SELECT workspace_id FROM events WHERE type='pull_request.associated'
                AND json_extract(payload,'$.repositoryId')=?2 AND json_extract(payload,'$.pullRequest')=?3))
            ORDER BY occurred_at, sequence").map_err(|_| FAILURE)?;
        let result = statement
            .query_map(
                params![
                    filter.workspace_id,
                    filter.repository_id,
                    filter.pull_request.map(|n| n as i64)
                ],
                row,
            )
            .map_err(|_| FAILURE)?
            .collect::<std::result::Result<_, _>>()
            .map_err(|_| FAILURE.into());
        result
    }
}
fn add(total: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *total = Some(total.unwrap_or(0).saturating_add(value));
    }
}
fn union(intervals: &mut [(u64, u64)]) -> u64 {
    intervals.sort_unstable();
    let mut end = 0;
    let mut total = 0;
    for &(a, b) in intervals.iter() {
        total += b.saturating_sub(a.max(end));
        end = end.max(b);
    }
    total
}
/// Observed monotonic duration and wall placement must agree within one second. A clock jump
/// cannot silently inflate overlap time. Incomplete intervals never end at the query boundary.
fn interval(
    start: u64,
    end: u64,
    elapsed: u64,
    filter: &Filter,
) -> std::result::Result<Option<(u64, u64)>, ()> {
    if end < start || (end - start).abs_diff(elapsed) > 1000 {
        return Err(());
    }
    let a = start.max(filter.from.unwrap_or(0));
    let b = end.min(filter.to.unwrap_or(i64::MAX as u64));
    Ok((b > a || (start == end && filter.includes(start))).then_some((a, b)))
}
fn summarize(events: &[Event], filter: &Filter, health: Health) -> Summary {
    let mut s = Summary {
        health,
        ..Summary::default()
    };
    let mut turns = HashMap::new();
    let mut measurements = HashMap::new();
    let mut completed = BTreeSet::new();
    let mut executions = HashMap::new();
    let mut ended = HashMap::new();
    let mut waits = HashMap::new();
    let mut received = HashMap::new();
    let mut workspaces = BTreeSet::new();
    // Insertion order determines latest usage, even after a wall-clock correction.
    let mut ordered: Vec<_> = events.iter().collect();
    ordered.sort_by_key(|e| e.sequence);
    for e in ordered {
        if let Some(w) = &e.scope.workspace_id {
            workspaces.insert(w.clone());
        }
        if filter.includes(e.occurred_at) {
            s.events += 1;
            s.first_recorded_at = Some(
                s.first_recorded_at
                    .map_or(e.occurred_at, |v| v.min(e.occurred_at)),
            );
            s.last_recorded_at = Some(
                s.last_recorded_at
                    .map_or(e.occurred_at, |v| v.max(e.occurred_at)),
            );
        }
        let tid = e.scope.turn_id.clone().unwrap_or_default();
        match &e.fact {
            Fact::TurnStarted { .. } => {
                turns.insert(tid, e.occurred_at);
            }
            Fact::UsageObserved { measurement } => {
                if !completed.contains(&tid) {
                    measurements.insert(tid, measurement);
                }
            }
            Fact::TurnCompleted { measurement, .. } => {
                completed.insert(tid.clone());
                measurements.insert(tid, measurement);
            }
            Fact::ExecutionStarted { execution_id } => {
                executions.insert(execution_id, e.occurred_at);
            }
            Fact::ExecutionCompleted {
                execution_id,
                elapsed_ms,
            } => {
                ended.insert(execution_id, (e.occurred_at, *elapsed_ms));
            }
            Fact::HumanRequested { request_id, .. } => {
                waits.insert(request_id, e.occurred_at);
            }
            Fact::HumanReceived {
                request_id,
                elapsed_ms,
            } => {
                received.insert(request_id, (e.occurred_at, *elapsed_ms, true));
            }
            Fact::HumanCancelled {
                request_id,
                elapsed_ms,
            } => {
                received.insert(request_id, (e.occurred_at, *elapsed_ms, false));
            }
            _ => {}
        }
    }
    for (tid, at) in turns {
        if !filter.includes(at) {
            continue;
        }
        s.turns += 1;
        if completed.contains(&tid) {
            s.completed_turns += 1;
        }
        if let Some(m) = measurements.get(&tid) {
            if (!completed.contains(&tid) || !m.complete)
                && (m.usage.input_tokens.is_some() || m.usage.output_tokens.is_some())
            {
                s.partial_turns += 1;
            }
            if m.complete && m.usage.input_tokens.is_some() && m.usage.output_tokens.is_some() {
                s.measured_turns += 1;
            }
            add(&mut s.input_tokens, m.usage.input_tokens);
            add(&mut s.output_tokens, m.usage.output_tokens);
            if let Some(cost) = m.usage.cost_usd {
                s.cost_usd = Some(s.cost_usd.unwrap_or(0.) + cost);
            }
        }
    }
    let mut intervals = vec![];
    for (id, start) in executions {
        if let Some(&(end, elapsed)) = ended.get(id) {
            match interval(start, end, elapsed, filter) {
                Ok(Some((a, b))) => {
                    s.complete_executions += 1;
                    add(&mut s.execution_sum_ms, Some(b - a));
                    intervals.push((a, b));
                }
                Err(()) if filter.includes(start) || filter.includes(end) => s.clock_anomalies += 1,
                _ => {}
            }
        } else if start < filter.to.unwrap_or(i64::MAX as u64) {
            s.incomplete_executions += 1;
        }
    }
    if !intervals.is_empty() {
        s.active_agent_ms = Some(union(&mut intervals));
    }
    let mut intervals = vec![];
    for (id, start) in waits {
        if let Some(&(end, elapsed, responded)) = received.get(id) {
            match interval(start, end, elapsed, filter) {
                Ok(Some(pair)) => {
                    if responded {
                        s.responded_waits += 1;
                    } else {
                        s.cancelled_waits += 1;
                    }
                    intervals.push(pair);
                }
                Err(()) if filter.includes(start) || filter.includes(end) => s.clock_anomalies += 1,
                _ => {}
            }
        } else if start < filter.to.unwrap_or(i64::MAX as u64) {
            s.incomplete_waits += 1;
        }
    }
    if !intervals.is_empty() {
        s.human_wait_ms = Some(union(&mut intervals));
    }
    s.workspace_ids = workspaces.into_iter().collect();
    s
}
impl Service {
    pub fn summary(&mut self, filter: &Filter) -> Result<Summary> {
        filter.validate()?;
        let Some(store) = &self.store else {
            return Ok(Summary {
                health: self.health.clone(),
                ..Summary::default()
            });
        };
        // ponytail: aggregate selected workspace history in memory; materialize projections when
        // measured history size makes this interactive query slow.
        let events = store.events(filter)?;
        Ok(summarize(&events, filter, self.health.clone()))
    }
    pub fn page(&self, filter: &Filter, cursor: Option<Cursor>) -> Result<Page> {
        filter.validate()?;
        if cursor
            .as_ref()
            .is_some_and(|c| c.occurred_at > i64::MAX as u64 || c.sequence > i64::MAX as u64)
        {
            return Err("err.telemetry.filter".into());
        }
        let store = self.store.as_ref().ok_or(FAILURE)?;
        let mut statement = store.db.prepare("SELECT * FROM events
            WHERE occurred_at >= ?1 AND occurred_at < ?2
            AND (?3 IS NULL OR workspace_id=?3)
            AND (?4 IS NULL OR workspace_id IN (SELECT workspace_id FROM events WHERE type='pull_request.associated' AND json_extract(payload,'$.repositoryId')=?4 AND json_extract(payload,'$.pullRequest')=?5))
            AND (?6 IS NULL OR (occurred_at,sequence)>(?6,?7))
            ORDER BY occurred_at,sequence LIMIT 501").map_err(|_|FAILURE)?;
        let mut events = statement
            .query_map(
                params![
                    filter.from.unwrap_or(0) as i64,
                    filter.to.unwrap_or(i64::MAX as u64) as i64,
                    filter.workspace_id,
                    filter.repository_id,
                    filter.pull_request.map(|n| n as i64),
                    cursor.as_ref().map(|c| c.occurred_at as i64),
                    cursor.as_ref().map(|c| c.sequence as i64)
                ],
                row,
            )
            .map_err(|_| FAILURE)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| FAILURE)?;
        let more = events.len() > 500;
        events.truncate(500);
        let next = if more {
            events.last().map(|e| Cursor {
                occurred_at: e.occurred_at,
                sequence: e.sequence,
            })
        } else {
            None
        };
        Ok(Page {
            events,
            next,
            health: self.health.clone(),
        })
    }
    pub fn export(&self, filter: &Filter) -> Result<String> {
        let events = self.store.as_ref().ok_or(FAILURE)?.events(filter)?;
        let mut lines=vec![serde_json::json!({"exportVersion":1,"health":self.health,"filter":filter,"summary":summarize(&events,filter,self.health.clone()),"eventSelection":"occurrence period; turn usage uses start cohort"}).to_string()];
        for e in events
            .into_iter()
            .filter(|e| filter.includes(e.occurred_at))
        {
            lines.push(serde_json::to_string(&e).map_err(|_| FAILURE)?);
        }
        Ok(lines.join("\n") + "\n")
    }
}
