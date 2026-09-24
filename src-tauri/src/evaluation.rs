//! Application-owned boundary for optional, bounded context evaluation (ADR 0058).
//!
//! A feature asks a small set of closed questions about a bounded text context and receives one
//! outcome and confidence per answered question. The port knows nothing about any vendor payload,
//! credential or transport; adapters such as `typesafe.rs` implement it at the edge. Features select
//! what to show from the answers with their own rules, so a new consumer reuses this port without a
//! provider marketplace or orchestration layer.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

/// Upper bound for the context text sent to an evaluator, in bytes of UTF-8.
pub const MAX_CONTEXT: usize = 24 * 1024;
/// A request asks at most this many independent questions in one call.
pub const MAX_QUESTIONS: usize = 8;
const MAX_PROMPT: usize = 600;
const MAX_OUTCOMES: usize = 8;
const MAX_TOKEN: usize = 40;

/// One narrow question with a closed set of outcomes.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Question {
    pub id: String,
    pub prompt: String,
    pub outcomes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct EvaluationRequest {
    pub context: String,
    pub questions: Vec<Question>,
}

/// An answered question. Omitted questions mean the evaluator abstained.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Answer {
    pub id: String,
    pub outcome: String,
    pub confidence: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct EvaluationResult {
    pub answers: Vec<Answer>,
}

/// Application-owned failure codes. Adapters translate vendor statuses into these; no response
/// body, URL or credential travels with them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationError {
    /// The integration is disabled or has no credential.
    Disabled,
    /// The service rejected the credential.
    Auth,
    RateLimited,
    /// Offline, timeout or a server failure after bounded retries.
    Unavailable,
    /// The response did not match the closed questions that were asked.
    Malformed,
    /// The request exceeded the port's bounds or the service refused it as invalid.
    Invalid,
    /// Configuration changed while the call was in flight; the result must not be used.
    Stale,
}

impl EvaluationError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Auth => "auth",
            Self::RateLimited => "rate_limited",
            Self::Unavailable => "unavailable",
            Self::Malformed => "malformed",
            Self::Invalid => "invalid",
            Self::Stale => "stale",
        }
    }

    /// IPC form: a stable i18n code the frontend translates and inspects.
    pub fn to_ipc(self) -> String {
        crate::i18n::t(&format!("err.evaluation.{}", self.code()))
    }
}

/// The port implemented by adapters and by test fakes. `cancelled` lets an adapter stop between
/// retries when the configuration changes.
pub trait Evaluator {
    fn evaluate(
        &self,
        request: &EvaluationRequest,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<Answer>, EvaluationError>;
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
}

/// Enforce the bounds before any adapter sees the request.
pub fn validate(request: &EvaluationRequest) -> Result<(), EvaluationError> {
    if request.context.trim().is_empty()
        || request.context.len() > MAX_CONTEXT
        || request.questions.is_empty()
        || request.questions.len() > MAX_QUESTIONS
    {
        return Err(EvaluationError::Invalid);
    }
    let mut ids = HashSet::new();
    for question in &request.questions {
        let mut outcomes = HashSet::new();
        if !token(&question.id)
            || !ids.insert(question.id.as_str())
            || question.prompt.trim().is_empty()
            || question.prompt.len() > MAX_PROMPT
            || !(2..=MAX_OUTCOMES).contains(&question.outcomes.len())
            || !question
                .outcomes
                .iter()
                .all(|outcome| token(outcome) && outcomes.insert(outcome.as_str()))
        {
            return Err(EvaluationError::Invalid);
        }
    }
    Ok(())
}

/// Validate what an adapter returned against the questions asked. Unknown questions, outcomes
/// outside the closed set, duplicates and invalid confidences are malformed; omissions abstain.
pub fn accept(
    request: &EvaluationRequest,
    answers: Vec<Answer>,
) -> Result<Vec<Answer>, EvaluationError> {
    let mut seen = HashSet::new();
    for answer in &answers {
        let Some(question) = request.questions.iter().find(|q| q.id == answer.id) else {
            return Err(EvaluationError::Malformed);
        };
        if !seen.insert(answer.id.as_str())
            || !question.outcomes.contains(&answer.outcome)
            || !answer.confidence.is_finite()
            || !(0.0..=1.0).contains(&answer.confidence)
        {
            return Err(EvaluationError::Malformed);
        }
    }
    Ok(answers)
}

/// A configuration generation. Enabling, disabling, replacing or removing the credential bumps it,
/// so an evaluation that started under another generation is reported as stale.
#[derive(Default)]
pub struct Generation(AtomicU64);

impl Generation {
    pub const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn bump(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Run one evaluation: validate, call the port unless disabled, and discard results whose
/// configuration generation changed during the call.
pub fn run(
    request: &EvaluationRequest,
    evaluator: Option<&dyn Evaluator>,
    generation: &Generation,
) -> Result<EvaluationResult, EvaluationError> {
    let Some(evaluator) = evaluator else {
        return Err(EvaluationError::Disabled);
    };
    validate(request)?;
    let started = generation.current();
    let changed = || generation.current() != started;
    let answers = evaluator.evaluate(request, &changed);
    if changed() {
        return Err(EvaluationError::Stale);
    }
    Ok(EvaluationResult {
        answers: accept(request, answers?)?,
    })
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::cell::RefCell;

    /// Scripted evaluator for tests; records every request it receives.
    pub struct Fake {
        pub reply: Result<Vec<Answer>, EvaluationError>,
        pub calls: RefCell<Vec<EvaluationRequest>>,
        pub during: Option<Box<dyn Fn()>>,
    }

    impl Fake {
        pub fn new(reply: Result<Vec<Answer>, EvaluationError>) -> Self {
            Self {
                reply,
                calls: RefCell::new(Vec::new()),
                during: None,
            }
        }
    }

    impl Evaluator for Fake {
        fn evaluate(
            &self,
            request: &EvaluationRequest,
            _: &dyn Fn() -> bool,
        ) -> Result<Vec<Answer>, EvaluationError> {
            self.calls.borrow_mut().push(request.clone());
            if let Some(during) = &self.during {
                during();
            }
            self.reply.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Fake;
    use super::*;
    use std::sync::Arc;

    pub fn request() -> EvaluationRequest {
        EvaluationRequest {
            context: "Fix the CSV import for existing customers".into(),
            questions: vec![Question {
                id: "business_rule".into(),
                prompt: "Is an unresolved business rule present?".into(),
                outcomes: vec!["present".into(), "absent".into()],
            }],
        }
    }

    fn answer(outcome: &str, confidence: f64) -> Answer {
        Answer {
            id: "business_rule".into(),
            outcome: outcome.into(),
            confidence,
        }
    }

    #[test]
    fn disabled_path_makes_zero_calls() {
        let generation = Generation::new();
        assert_eq!(
            run(&request(), None, &generation),
            Err(EvaluationError::Disabled)
        );
    }

    #[test]
    fn a_fake_evaluator_answers_through_the_port() {
        let fake = Fake::new(Ok(vec![answer("absent", 0.9)]));
        let result = run(&request(), Some(&fake), &Generation::new()).unwrap();
        assert_eq!(result.answers, vec![answer("absent", 0.9)]);
        assert_eq!(fake.calls.borrow().len(), 1);
    }

    #[test]
    fn invalid_requests_never_reach_the_evaluator() {
        let fake = Fake::new(Ok(vec![]));
        let generation = Generation::new();
        let mut large = request();
        large.context = "x".repeat(MAX_CONTEXT + 1);
        let mut duplicate = request();
        duplicate.questions.push(duplicate.questions[0].clone());
        let mut open = request();
        open.questions[0].outcomes = vec!["anything".into()];
        let mut shaped = request();
        shaped.questions[0].id = "Bad Id".into();
        for bad in [large, duplicate, open, shaped] {
            assert_eq!(
                run(&bad, Some(&fake), &generation),
                Err(EvaluationError::Invalid)
            );
        }
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn answers_outside_the_closed_questions_are_malformed() {
        let generation = Generation::new();
        for reply in [
            vec![answer("maybe", 0.9)],
            vec![answer("absent", 1.2)],
            vec![answer("absent", f64::NAN)],
            vec![answer("absent", 0.9), answer("present", 0.8)],
            vec![Answer {
                id: "other".into(),
                outcome: "absent".into(),
                confidence: 0.9,
            }],
        ] {
            let fake = Fake::new(Ok(reply));
            assert_eq!(
                run(&request(), Some(&fake), &generation),
                Err(EvaluationError::Malformed)
            );
        }
        let silent = Fake::new(Ok(vec![]));
        assert_eq!(
            run(&request(), Some(&silent), &generation)
                .unwrap()
                .answers
                .len(),
            0
        );
    }

    #[test]
    fn configuration_changes_during_a_call_invalidate_the_result() {
        let generation = Arc::new(Generation::new());
        let mut fake = Fake::new(Ok(vec![answer("absent", 0.9)]));
        let during = generation.clone();
        fake.during = Some(Box::new(move || {
            during.bump();
        }));
        assert_eq!(
            run(&request(), Some(&fake), &generation),
            Err(EvaluationError::Stale)
        );
    }

    #[test]
    fn errors_cross_ipc_as_application_codes() {
        assert_eq!(
            EvaluationError::RateLimited.to_ipc(),
            r#"i18n:{"code":"err.evaluation.rate_limited"}"#
        );
    }
}
