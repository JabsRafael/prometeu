use super::*;

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
// Reused within one read transaction so late completions and PR relations share a snapshot.
const SELECTED: &str = "WITH selected AS NOT MATERIALIZED (
    SELECT * FROM events WHERE (?1 IS NULL OR workspace_id=?1)
    AND (?2 IS NULL OR workspace_id IN (SELECT workspace_id FROM events
        WHERE type='pull_request.associated' AND json_extract(payload,'$.repositoryId')=?2
        AND json_extract(payload,'$.pullRequest')=?3)))";

pub struct Queries {
    path: PathBuf,
    health: Health,
    readers: Arc<RwLock<()>>,
}
impl Service {
    pub fn queries(&self) -> Queries {
        Queries {
            path: self.root.join("telemetry.sqlite3"),
            health: self.health.clone(),
            readers: self.readers.clone(),
        }
    }
}
impl Queries {
    pub(super) fn read<T>(&self, run: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
        // Erasure waits for existing readers and exports, but capture never takes this lock.
        let _reading = self.readers.read().unwrap_or_else(|e| e.into_inner());
        if self.health.unavailable {
            return Err(FAILURE.into());
        }
        let db =
            Connection::open_with_flags(&self.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| FAILURE)?;
        db.busy_timeout(std::time::Duration::from_millis(250))
            .map_err(|_| FAILURE)?;
        db.execute_batch("PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; BEGIN;")
            .map_err(|_| FAILURE)?;
        // Connection close releases the snapshot before the erasure guard is released.
        run(&Store { db })
    }
    pub fn summary(&self, filter: &Filter) -> Result<Summary> {
        filter.validate()?;
        if self.health.unavailable {
            return Ok(Summary {
                health: self.health.clone(),
                ..Default::default()
            });
        }
        self.read(|store| store.summary(filter, self.health.clone()))
    }
    pub fn page(&self, filter: &Filter, cursor: Option<Cursor>) -> Result<Page> {
        self.read(|store| store.page(filter, cursor, self.health.clone()))
    }
    pub fn export_to(&self, filter: &Filter, path: &Path) -> Result<()> {
        self.read(|store| {
            let summary = store.summary(filter, self.health.clone())?;
            write_export(path, |writer| store.export(filter, &summary, writer))
        })
    }
    #[cfg(test)]
    pub fn export(&self, filter: &Filter) -> Result<String> {
        self.read(|store| {
            let summary = store.summary(filter, self.health.clone())?;
            let mut bytes = Vec::new();
            store.export(filter, &summary, &mut bytes)?;
            String::from_utf8(bytes).map_err(|_| FAILURE.into())
        })
    }
}
fn add(total: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *total = Some(total.unwrap_or(0).saturating_add(value));
    }
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
impl Store {
    pub(super) fn summary(&self, filter: &Filter, health: Health) -> Result<Summary> {
        filter.validate()?;
        let parameters = params![
            filter.workspace_id,
            filter.repository_id,
            filter.pull_request.map(|n| n as i64),
            filter.from.unwrap_or(0) as i64,
            filter.to.unwrap_or(i64::MAX as u64) as i64
        ];
        let mut s = self
            .db
            .query_row(
                &format!(
                    "{SELECTED}
            SELECT COUNT(*),MIN(occurred_at),MAX(occurred_at) FROM selected
            WHERE occurred_at>=?4 AND occurred_at<?5"
                ),
                parameters,
                |r| {
                    Ok(Summary {
                        events: r.get::<_, i64>(0)? as u64,
                        first_recorded_at: r.get::<_, Option<i64>>(1)?.map(|v| v as u64),
                        last_recorded_at: r.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                        health,
                        ..Default::default()
                    })
                },
            )
            .map_err(|_| FAILURE)?;
        let mut statement = self.db.prepare(&format!("{SELECTED}
            SELECT DISTINCT workspace_id FROM selected WHERE workspace_id IS NOT NULL ORDER BY workspace_id"))
            .map_err(|_| FAILURE)?;
        s.workspace_ids = statement
            .query_map(
                params![
                    Option::<String>::None,
                    filter.repository_id,
                    filter.pull_request.map(|n| n as i64)
                ],
                |r| r.get(0),
            )
            .map_err(|_| FAILURE)?
            .collect::<rusqlite::Result<_>>()
            .map_err(|_| FAILURE)?;
        // Resolve only the final snapshot for each start in the cohort; intermediate snapshots
        // and completed turns never accumulate in application memory.
        let mut statement = self.db.prepare(&format!("{SELECTED}
            SELECT m.type,m.payload FROM selected AS start
            LEFT JOIN events AS m ON m.sequence=COALESCE(
                (SELECT sequence FROM events WHERE turn_id=start.turn_id AND type='turn.completed' ORDER BY sequence DESC LIMIT 1),
                (SELECT sequence FROM events WHERE turn_id=start.turn_id AND type='turn.usage.observed' ORDER BY sequence DESC LIMIT 1))
            WHERE start.type='turn.started' AND start.occurred_at>=?4 AND start.occurred_at<?5"))
            .map_err(|_| FAILURE)?;
        let mut rows = statement.query(parameters).map_err(|_| FAILURE)?;
        while let Some(row) = rows.next().map_err(|_| FAILURE)? {
            s.turns += 1;
            let kind: Option<String> = row.get(0).map_err(|_| FAILURE)?;
            let completed = kind.as_deref() == Some("turn.completed");
            s.completed_turns += u64::from(completed);
            if let Some(payload) = row.get::<_, Option<String>>(1).map_err(|_| FAILURE)? {
                let fact: Fact = serde_json::from_value(serde_json::json!({"type":kind,"payload":serde_json::from_str::<serde_json::Value>(&payload).map_err(|_| FAILURE)?})).map_err(|_| FAILURE)?;
                let m = fact.measurement().ok_or(FAILURE)?;
                if (!completed || !m.complete)
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
        for waiting in [false, true] {
            let (start_type, end_types, identity) = if waiting {
                (
                    "human_input.requested",
                    "'human_input.received','human_input.cancelled'",
                    "requestId",
                )
            } else {
                (
                    "agent.execution.started",
                    "'agent.execution.completed'",
                    "executionId",
                )
            };
            let mut statement = self.db.prepare(&format!("{SELECTED}
                SELECT start.occurred_at,finish.occurred_at,json_extract(finish.payload,'$.elapsedMs'),finish.type
                FROM selected AS start LEFT JOIN events AS finish ON finish.sequence=(
                    SELECT sequence FROM events WHERE type IN ({end_types})
                    AND json_extract(payload,'$.{identity}')=json_extract(start.payload,'$.{identity}')
                    ORDER BY sequence DESC LIMIT 1)
                WHERE start.type='{start_type}' ORDER BY start.occurred_at,start.sequence"))
                .map_err(|_| FAILURE)?;
            let mut rows = statement
                .query(params![
                    filter.workspace_id,
                    filter.repository_id,
                    filter.pull_request.map(|n| n as i64)
                ])
                .map_err(|_| FAILURE)?;
            let mut union_end = 0;
            let mut union_ms = None;
            while let Some(row) = rows.next().map_err(|_| FAILURE)? {
                let start = row.get::<_, i64>(0).map_err(|_| FAILURE)? as u64;
                let end = row
                    .get::<_, Option<i64>>(1)
                    .map_err(|_| FAILURE)?
                    .map(|v| v as u64);
                if let Some(end) = end {
                    let elapsed = row.get::<_, i64>(2).map_err(|_| FAILURE)? as u64;
                    match interval(start, end, elapsed, filter) {
                        Ok(Some((a, b))) => {
                            if waiting {
                                if row.get::<_, String>(3).map_err(|_| FAILURE)?
                                    == "human_input.received"
                                {
                                    s.responded_waits += 1;
                                } else {
                                    s.cancelled_waits += 1;
                                }
                            } else {
                                s.complete_executions += 1;
                                add(&mut s.execution_sum_ms, Some(b - a));
                            }
                            add(&mut union_ms, Some(b.saturating_sub(a.max(union_end))));
                            union_end = union_end.max(b);
                        }
                        Err(()) if filter.includes(start) || filter.includes(end) => {
                            s.clock_anomalies += 1
                        }
                        _ => {}
                    }
                } else if start < filter.to.unwrap_or(i64::MAX as u64) {
                    if waiting {
                        s.incomplete_waits += 1;
                    } else {
                        s.incomplete_executions += 1;
                    }
                }
            }
            if waiting {
                s.human_wait_ms = union_ms;
            } else {
                s.active_agent_ms = union_ms;
            }
        }
        Ok(s)
    }
    pub(super) fn page(
        &self,
        filter: &Filter,
        cursor: Option<Cursor>,
        health: Health,
    ) -> Result<Page> {
        filter.validate()?;
        if cursor
            .as_ref()
            .is_some_and(|c| c.occurred_at > i64::MAX as u64 || c.sequence > i64::MAX as u64)
        {
            return Err("err.telemetry.filter".into());
        }
        let mut statement = self.db.prepare("SELECT * FROM events
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
            health,
        })
    }
    pub(super) fn export(
        &self,
        filter: &Filter,
        summary: &Summary,
        writer: &mut dyn std::io::Write,
    ) -> Result<()> {
        fn line(writer: &mut dyn std::io::Write, value: &impl Serialize) -> Result<()> {
            serde_json::to_writer(&mut *writer, value).map_err(|_| "err.telemetry.export")?;
            writer
                .write_all(b"\n")
                .map_err(|_| "err.telemetry.export".into())
        }
        line(
            writer,
            &serde_json::json!({"exportVersion":1,"health":summary.health,"filter":filter,"summary":summary,"eventSelection":"occurrence period; turn usage uses start cohort"}),
        )?;
        let mut statement = self.db.prepare(&format!("{SELECTED}
            SELECT * FROM selected WHERE occurred_at>=?4 AND occurred_at<?5 ORDER BY occurred_at,sequence"))
            .map_err(|_| FAILURE)?;
        let mut rows = statement
            .query(params![
                filter.workspace_id,
                filter.repository_id,
                filter.pull_request.map(|n| n as i64),
                filter.from.unwrap_or(0) as i64,
                filter.to.unwrap_or(i64::MAX as u64) as i64
            ])
            .map_err(|_| FAILURE)?;
        while let Some(r) = rows.next().map_err(|_| FAILURE)? {
            line(writer, &row(r).map_err(|_| FAILURE)?)?;
        }
        Ok(())
    }
}
