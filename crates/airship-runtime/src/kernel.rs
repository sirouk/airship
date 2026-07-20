use crate::schema::{
    AssistantMessage, AssistantOutput, Command, DurableEvent, Effect, EffectResult, EventId,
    EventKind, EventRecord, FailureCode, InferenceRequest, KernelInput, KernelStatus, MessageId,
    OperationId, PersistRequest, SessionId, SessionManifest, ToolCall, ToolCallId, ToolInvocation,
    ToolOutcome, TranscriptMessage, Transition, TurnFailure, TurnId, TurnTerminal, UserMessage,
    SCHEMA_VERSION,
};
use core::fmt;
use std::collections::BTreeSet;

const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_MANIFEST_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelError {
    UnsupportedSchemaVersion {
        found: u16,
    },
    InvalidManifest {
        reason: String,
    },
    InvalidInput {
        reason: String,
    },
    InvalidState {
        reason: String,
    },
    PersistenceInFlight {
        event_id: EventId,
    },
    PersistenceMismatch {
        reason: String,
    },
    SequenceMismatch {
        expected: u64,
        found: u64,
    },
    StaleOperation {
        operation_id: OperationId,
    },
    LimitExceeded {
        field: &'static str,
        limit: usize,
        actual: usize,
    },
    ReplayViolation {
        reason: String,
    },
    NonRetryablePersistence {
        event_id: EventId,
        message: String,
    },
}

impl fmt::Display for KernelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion { found } => {
                write!(formatter, "unsupported schema version {found}")
            }
            Self::InvalidManifest { reason } => write!(formatter, "invalid manifest: {reason}"),
            Self::InvalidInput { reason } => write!(formatter, "invalid input: {reason}"),
            Self::InvalidState { reason } => write!(formatter, "invalid state: {reason}"),
            Self::PersistenceInFlight { event_id } => {
                write!(formatter, "persistence is already in flight for {event_id}")
            }
            Self::PersistenceMismatch { reason } => {
                write!(formatter, "persistence acknowledgement mismatch: {reason}")
            }
            Self::SequenceMismatch { expected, found } => {
                write!(formatter, "expected log sequence {expected}, found {found}")
            }
            Self::StaleOperation { operation_id } => {
                write!(formatter, "stale or unknown operation: {operation_id:?}")
            }
            Self::LimitExceeded {
                field,
                limit,
                actual,
            } => write!(
                formatter,
                "{field} exceeds its bound: limit={limit}, actual={actual}"
            ),
            Self::ReplayViolation { reason } => write!(formatter, "invalid event log: {reason}"),
            Self::NonRetryablePersistence { event_id, message } => write!(
                formatter,
                "non-retryable persistence failure for {event_id}: {message}"
            ),
        }
    }
}

impl std::error::Error for KernelError {}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssistantStep {
    step: u32,
    calls: Vec<ToolCall>,
    next_terminal_index: usize,
}

impl AssistantStep {
    fn unresolved_call(&self) -> Option<(usize, &ToolCall)> {
        self.calls
            .get(self.next_terminal_index)
            .map(|call| (self.next_terminal_index, call))
    }

    fn is_resolved(&self) -> bool {
        self.next_terminal_index == self.calls.len()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActiveTurn {
    turn_id: TurnId,
    steps_started: u32,
    current_inference: Option<OperationId>,
    assistant_step: Option<AssistantStep>,
    cancellation_reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Projection {
    manifest: Option<SessionManifest>,
    next_sequence: u64,
    transcript: Vec<TranscriptMessage>,
    active_turn: Option<ActiveTurn>,
    seen_event_ids: BTreeSet<EventId>,
    seen_turn_ids: BTreeSet<TurnId>,
    seen_tool_call_ids: BTreeSet<ToolCallId>,
    last_terminal: Option<(TurnId, TurnTerminal)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Kernel {
    projection: Projection,
    pending_persist: Option<PersistRequest>,
    in_flight: Option<OperationId>,
}

impl Kernel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuild a kernel solely from committed events. External effects are not
    /// emitted until [`Self::recover`] is called.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError`] when a record has an unsupported schema,
    /// non-contiguous sequence, unstable identifier, or invalid turn grammar.
    pub fn replay(records: &[EventRecord]) -> Result<Self, KernelError> {
        let mut kernel = Self::new();
        for record in records {
            kernel.projection.apply_record(record)?;
        }
        Ok(kernel)
    }

    /// Replay and require the complete pinned manifest to match byte-for-byte.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError`] for any replay violation or if the stored
    /// manifest differs from `expected_manifest`.
    pub fn replay_expected(
        expected_manifest: &SessionManifest,
        records: &[EventRecord],
    ) -> Result<Self, KernelError> {
        let kernel = Self::replay(records)?;
        match kernel.manifest() {
            Some(actual) if actual == expected_manifest => Ok(kernel),
            Some(_) => Err(KernelError::ReplayViolation {
                reason: "stored session manifest differs from the expected pinned manifest"
                    .to_owned(),
            }),
            None => Err(KernelError::ReplayViolation {
                reason: "event log does not contain session.created".to_owned(),
            }),
        }
    }

    /// Re-issue the deterministic idempotent effect implied by an incomplete
    /// durable turn. Tool recovery must reconcile by operation ID rather than
    /// blindly repeating a non-idempotent side effect.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError`] when persistence or an external operation is
    /// already in flight, or when the durable projection is invalid.
    pub fn recover(&mut self) -> Result<Transition, KernelError> {
        self.transactional(|candidate| {
            if let Some(pending) = &candidate.pending_persist {
                return Err(KernelError::PersistenceInFlight {
                    event_id: pending.event.event_id.clone(),
                });
            }
            if let Some(operation_id) = &candidate.in_flight {
                return Err(KernelError::InvalidState {
                    reason: format!("operation {operation_id:?} is already in flight"),
                });
            }
            candidate.drive(true)
        })
    }

    /// Apply a command or an external effect result. On error, the kernel is
    /// left byte-for-byte unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError`] for stale effect results, mismatched persistence
    /// acknowledgements, invalid commands, limits, or turn-grammar violations.
    pub fn transition(&mut self, input: KernelInput) -> Result<Transition, KernelError> {
        self.transactional(|candidate| match input {
            KernelInput::Command(command) => candidate.apply_command(command),
            KernelInput::EffectResult(result) => candidate.apply_effect_result(result),
        })
    }

    #[must_use]
    pub fn status(&self) -> KernelStatus {
        if let Some(request) = &self.pending_persist {
            return KernelStatus::Persisting {
                event_id: request.event.event_id.clone(),
            };
        }
        if let Some(operation_id) = &self.in_flight {
            return match operation_id {
                OperationId::Inference { .. } => KernelStatus::Inferring {
                    operation_id: operation_id.clone(),
                },
                OperationId::Tool { .. } => KernelStatus::ExecutingTool {
                    operation_id: operation_id.clone(),
                },
            };
        }
        if let Some(active) = &self.projection.active_turn {
            return KernelStatus::Recoverable {
                turn_id: active.turn_id.clone(),
            };
        }
        if self.projection.manifest.is_some() {
            KernelStatus::Ready
        } else {
            KernelStatus::Uninitialized
        }
    }

    #[must_use]
    pub fn manifest(&self) -> Option<&SessionManifest> {
        self.projection.manifest.as_ref()
    }

    #[must_use]
    pub fn transcript(&self) -> &[TranscriptMessage] {
        &self.projection.transcript
    }

    #[must_use]
    pub fn next_sequence(&self) -> u64 {
        self.projection.next_sequence
    }

    #[must_use]
    pub fn active_turn_id(&self) -> Option<&TurnId> {
        self.projection
            .active_turn
            .as_ref()
            .map(|active| &active.turn_id)
    }

    #[must_use]
    pub fn last_terminal(&self) -> Option<(&TurnId, &TurnTerminal)> {
        self.projection
            .last_terminal
            .as_ref()
            .map(|(turn_id, terminal)| (turn_id, terminal))
    }

    #[must_use]
    pub fn pending_persist(&self) -> Option<&PersistRequest> {
        self.pending_persist.as_ref()
    }

    fn transactional<F>(&mut self, operation: F) -> Result<Transition, KernelError>
    where
        F: FnOnce(&mut Self) -> Result<Vec<Effect>, KernelError>,
    {
        let mut candidate = self.clone();
        let effects = operation(&mut candidate)?;
        let transition = Transition {
            effects,
            status: candidate.status(),
        };
        *self = candidate;
        Ok(transition)
    }

    fn apply_command(&mut self, command: Command) -> Result<Vec<Effect>, KernelError> {
        match command {
            Command::CreateSession { manifest } => {
                if self.projection.manifest.is_some() || self.pending_persist.is_some() {
                    return Err(KernelError::InvalidState {
                        reason: "session is already created or being created".to_owned(),
                    });
                }
                validate_manifest(&manifest)?;
                let manifest = *manifest;
                let session_id = manifest.session_id.clone();
                self.prepare_persist(session_id, None, EventKind::SessionCreated { manifest })
            }
            Command::StartTurn { turn_id, content } => {
                self.require_idle_for_command()?;
                let manifest = self.require_manifest()?;
                validate_identifier("turn_id", turn_id.as_str())?;
                validate_bounded(
                    "user message",
                    content.len(),
                    usize_from_u32(manifest.limits.max_message_bytes),
                )?;
                if content.trim().is_empty() {
                    return Err(KernelError::InvalidInput {
                        reason: "user message must not be empty".to_owned(),
                    });
                }
                if self.projection.active_turn.is_some() {
                    return Err(KernelError::InvalidState {
                        reason: "another turn is active".to_owned(),
                    });
                }
                if self.projection.seen_turn_ids.contains(&turn_id) {
                    return Err(KernelError::InvalidInput {
                        reason: format!("turn ID {turn_id} was already used"),
                    });
                }
                if !matches!(
                    self.projection.transcript.last(),
                    None | Some(TranscriptMessage::Assistant { .. })
                ) {
                    return Err(KernelError::InvalidState {
                        reason: "new user input would violate transcript role order".to_owned(),
                    });
                }
                let message = UserMessage {
                    id: user_message_id(&turn_id),
                    content,
                };
                self.prepare_session_persist(Some(turn_id), EventKind::TurnRequested { message })
            }
            Command::CancelTurn { turn_id, reason } => {
                if let Some(pending) = &self.pending_persist {
                    return Err(KernelError::PersistenceInFlight {
                        event_id: pending.event.event_id.clone(),
                    });
                }
                let manifest = self.require_manifest()?;
                validate_bounded(
                    "cancellation reason",
                    reason.len(),
                    usize_from_u32(manifest.limits.max_message_bytes),
                )?;
                if reason.trim().is_empty() {
                    return Err(KernelError::InvalidInput {
                        reason: "cancellation reason must not be empty".to_owned(),
                    });
                }
                let active = self.projection.active_turn.as_ref().ok_or_else(|| {
                    KernelError::InvalidState {
                        reason: "there is no active turn to cancel".to_owned(),
                    }
                })?;
                if active.turn_id != turn_id {
                    return Err(KernelError::InvalidInput {
                        reason: format!(
                            "cancel targets turn {turn_id}, but {} is active",
                            active.turn_id
                        ),
                    });
                }
                if active.cancellation_reason.is_some() {
                    return Err(KernelError::InvalidState {
                        reason: "turn cancellation is already durable".to_owned(),
                    });
                }

                let cancel_effect = self
                    .in_flight
                    .take()
                    .map(|operation_id| Effect::CancelOperation { operation_id });
                let mut effects = self.prepare_session_persist(
                    Some(turn_id),
                    EventKind::TurnCancellationRequested { reason },
                )?;
                if let Some(effect) = cancel_effect {
                    effects.push(effect);
                }
                Ok(effects)
            }
        }
    }

    fn apply_effect_result(&mut self, result: EffectResult) -> Result<Vec<Effect>, KernelError> {
        match result {
            EffectResult::Persisted { record } => self.acknowledge_persist(record.as_ref()),
            EffectResult::PersistenceFailed {
                event_id,
                retryable,
                message,
            } => {
                let pending = self.pending_persist.as_ref().ok_or_else(|| {
                    KernelError::PersistenceMismatch {
                        reason: "no event is awaiting persistence".to_owned(),
                    }
                })?;
                if pending.event.event_id != event_id {
                    return Err(KernelError::PersistenceMismatch {
                        reason: format!(
                            "failure references {event_id}, expected {}",
                            pending.event.event_id
                        ),
                    });
                }
                if retryable {
                    Ok(vec![Effect::Persist {
                        request: Box::new(pending.clone()),
                    }])
                } else {
                    Err(KernelError::NonRetryablePersistence { event_id, message })
                }
            }
            EffectResult::InferenceCompleted {
                operation_id,
                output,
            } => self.complete_inference(operation_id, output),
            EffectResult::InferenceFailed {
                operation_id,
                failure,
            } => self.fail_inference(operation_id, failure),
            EffectResult::ToolCompleted {
                operation_id,
                outcome,
            } => self.complete_tool(operation_id, outcome),
        }
    }

    fn acknowledge_persist(&mut self, record: &EventRecord) -> Result<Vec<Effect>, KernelError> {
        let pending =
            self.pending_persist
                .as_ref()
                .ok_or_else(|| KernelError::PersistenceMismatch {
                    reason: "no event is awaiting persistence".to_owned(),
                })?;
        if record.sequence != pending.expected_next_sequence {
            return Err(KernelError::SequenceMismatch {
                expected: pending.expected_next_sequence,
                found: record.sequence,
            });
        }
        if record.event != pending.event {
            return Err(KernelError::PersistenceMismatch {
                reason: "acknowledged event differs from the requested event".to_owned(),
            });
        }

        self.pending_persist = None;
        let terminal = terminal_from_event(&record.event);
        self.projection.apply_record(record)?;
        if let Some((turn_id, terminal)) = terminal {
            return Ok(vec![Effect::TurnFinalized { turn_id, terminal }]);
        }
        self.drive(false)
    }

    fn complete_inference(
        &mut self,
        operation_id: OperationId,
        output: AssistantOutput,
    ) -> Result<Vec<Effect>, KernelError> {
        self.require_no_pending_persist()?;
        self.require_in_flight(&operation_id)?;
        let (session_id, turn_id, step) = inference_parts(&operation_id)?;
        let manifest = self.require_manifest()?;
        validate_bounded(
            "assistant content",
            output.content.len(),
            usize_from_u32(manifest.limits.max_message_bytes),
        )?;
        validate_bounded(
            "tool call count",
            output.tool_calls.len(),
            usize_from_u32(manifest.limits.max_tool_calls_per_step),
        )?;
        if output.content.is_empty() && output.tool_calls.is_empty() {
            return Err(KernelError::InvalidInput {
                reason: "assistant output must contain text or at least one tool call".to_owned(),
            });
        }
        validate_tool_calls(
            manifest,
            &output.tool_calls,
            &self.projection.seen_tool_call_ids,
        )?;

        let active = self.require_active_turn(&turn_id)?;
        if active.cancellation_reason.is_some()
            || active.current_inference.as_ref() != Some(&operation_id)
        {
            return Err(KernelError::StaleOperation { operation_id });
        }

        self.in_flight = None;
        let message = AssistantMessage {
            id: assistant_message_id(&turn_id, step),
            content: output.content,
            tool_calls: output.tool_calls,
        };
        self.prepare_persist(
            session_id,
            Some(turn_id),
            EventKind::AssistantMessageRecorded {
                step,
                operation_id,
                message,
            },
        )
    }

    fn fail_inference(
        &mut self,
        operation_id: OperationId,
        failure: TurnFailure,
    ) -> Result<Vec<Effect>, KernelError> {
        self.require_no_pending_persist()?;
        self.require_in_flight(&operation_id)?;
        let (_, turn_id, _) = inference_parts(&operation_id)?;
        if failure.code == FailureCode::StepLimitExceeded {
            return Err(KernelError::InvalidInput {
                reason: "step-limit failures are generated by the kernel".to_owned(),
            });
        }
        self.validate_failure(&failure)?;
        let active = self.require_active_turn(&turn_id)?;
        if active.cancellation_reason.is_some()
            || active.current_inference.as_ref() != Some(&operation_id)
        {
            return Err(KernelError::StaleOperation { operation_id });
        }

        self.in_flight = None;
        let assistant = terminal_assistant_message(
            &turn_id,
            "failed",
            format!("[Turn failed: {}]", failure.message),
        );
        self.prepare_session_persist(Some(turn_id), EventKind::TurnFailed { failure, assistant })
    }

    fn complete_tool(
        &mut self,
        operation_id: OperationId,
        outcome: ToolOutcome,
    ) -> Result<Vec<Effect>, KernelError> {
        self.require_no_pending_persist()?;
        self.require_in_flight(&operation_id)?;
        let (_, turn_id, step, call_index, call_id) = tool_parts(&operation_id)?;
        self.validate_tool_outcome(&outcome)?;
        let active = self.require_active_turn(&turn_id)?;
        if active.cancellation_reason.is_some() {
            return Err(KernelError::StaleOperation { operation_id });
        }
        let assistant =
            active
                .assistant_step
                .as_ref()
                .ok_or_else(|| KernelError::InvalidState {
                    reason: "tool result has no preceding assistant tool request".to_owned(),
                })?;
        let (expected_index, expected_call) =
            assistant
                .unresolved_call()
                .ok_or_else(|| KernelError::StaleOperation {
                    operation_id: operation_id.clone(),
                })?;
        if assistant.step != step
            || expected_index != usize_from_u32(call_index)
            || expected_call.id != call_id
        {
            return Err(KernelError::StaleOperation { operation_id });
        }

        self.in_flight = None;
        self.prepare_session_persist(
            Some(turn_id),
            EventKind::ToolTerminalRecorded {
                step,
                call_index,
                operation_id,
                outcome,
            },
        )
    }

    #[allow(clippy::too_many_lines)]
    fn drive(&mut self, recovery: bool) -> Result<Vec<Effect>, KernelError> {
        if self.pending_persist.is_some() || self.in_flight.is_some() {
            return Ok(Vec::new());
        }
        let Some(active) = self.projection.active_turn.clone() else {
            return Ok(Vec::new());
        };
        let manifest = self.require_manifest()?.clone();

        if let Some(reason) = active.cancellation_reason {
            if let Some(assistant) = &active.assistant_step {
                if let Some((index, call)) = assistant.unresolved_call() {
                    let call_index = u32_from_usize(index)?;
                    let operation_id = tool_operation_id(
                        &manifest.session_id,
                        &active.turn_id,
                        assistant.step,
                        call_index,
                        &call.id,
                    );
                    return self.prepare_session_persist(
                        Some(active.turn_id),
                        EventKind::ToolTerminalRecorded {
                            step: assistant.step,
                            call_index,
                            operation_id,
                            outcome: ToolOutcome::Cancelled {
                                reason: reason.clone(),
                                outcome_unknown: index == assistant.next_terminal_index,
                            },
                        },
                    );
                }
            }
            let assistant = terminal_assistant_message(
                &active.turn_id,
                "cancelled",
                format!("[Turn cancelled: {reason}]"),
            );
            return self.prepare_session_persist(
                Some(active.turn_id),
                EventKind::TurnCancelled { reason, assistant },
            );
        }

        if let Some(operation_id) = active.current_inference {
            let request = self.build_inference_request(operation_id.clone())?;
            self.in_flight = Some(operation_id);
            return Ok(vec![if recovery {
                Effect::ResumeInference {
                    request: Box::new(request),
                }
            } else {
                Effect::StartInference {
                    request: Box::new(request),
                }
            }]);
        }

        if let Some(assistant) = active.assistant_step {
            if assistant.calls.is_empty() {
                return self
                    .prepare_session_persist(Some(active.turn_id), EventKind::TurnCompleted);
            }
            if let Some((index, call)) = assistant.unresolved_call() {
                let call_index = u32_from_usize(index)?;
                let operation_id = tool_operation_id(
                    &manifest.session_id,
                    &active.turn_id,
                    assistant.step,
                    call_index,
                    &call.id,
                );
                let invocation = self.build_tool_invocation(operation_id.clone(), call.clone())?;
                self.in_flight = Some(operation_id);
                return Ok(vec![if recovery {
                    Effect::RecoverTool { invocation }
                } else {
                    Effect::ExecuteTool { invocation }
                }]);
            }
            if !assistant.is_resolved() {
                return Err(KernelError::InvalidState {
                    reason: "tool terminal cursor exceeds the requested tool list".to_owned(),
                });
            }
        }

        if active.steps_started >= manifest.limits.max_steps {
            let failure = TurnFailure {
                code: FailureCode::StepLimitExceeded,
                message: format!(
                    "turn reached the configured step cap ({})",
                    manifest.limits.max_steps
                ),
                retryable: false,
            };
            let assistant = terminal_assistant_message(
                &active.turn_id,
                "failed",
                format!("[Turn failed: {}]", failure.message),
            );
            return self.prepare_session_persist(
                Some(active.turn_id),
                EventKind::TurnFailed { failure, assistant },
            );
        }

        let step = active.steps_started + 1;
        let operation_id = inference_operation_id(&manifest.session_id, &active.turn_id, step);
        self.prepare_session_persist(
            Some(active.turn_id),
            EventKind::InferenceStarted { step, operation_id },
        )
    }

    fn build_inference_request(
        &self,
        operation_id: OperationId,
    ) -> Result<InferenceRequest, KernelError> {
        let manifest = self.require_manifest()?;
        Ok(InferenceRequest {
            operation_id,
            manifest_digest: manifest.manifest_digest.clone(),
            system_prompt: manifest.system_prompt.clone(),
            model: manifest.model.clone(),
            tools: manifest.tools.clone(),
            messages: self.projection.transcript.clone(),
        })
    }

    fn build_tool_invocation(
        &self,
        operation_id: OperationId,
        call: ToolCall,
    ) -> Result<ToolInvocation, KernelError> {
        let manifest = self.require_manifest()?;
        let tool = manifest
            .tools
            .iter()
            .find(|tool| tool.name == call.name)
            .ok_or_else(|| KernelError::InvalidState {
                reason: format!("tool {} is not in the pinned manifest", call.name),
            })?;
        Ok(ToolInvocation {
            operation_id,
            call,
            effect: tool.effect.clone(),
        })
    }

    fn prepare_session_persist(
        &mut self,
        turn_id: Option<TurnId>,
        kind: EventKind,
    ) -> Result<Vec<Effect>, KernelError> {
        let session_id = self.require_manifest()?.session_id.clone();
        self.prepare_persist(session_id, turn_id, kind)
    }

    fn prepare_persist(
        &mut self,
        session_id: SessionId,
        turn_id: Option<TurnId>,
        kind: EventKind,
    ) -> Result<Vec<Effect>, KernelError> {
        if let Some(pending) = &self.pending_persist {
            return Err(KernelError::PersistenceInFlight {
                event_id: pending.event.event_id.clone(),
            });
        }
        let event_id = expected_event_id(&session_id, turn_id.as_ref(), &kind)?;
        let event = DurableEvent {
            schema_version: SCHEMA_VERSION,
            event_id,
            session_id,
            turn_id,
            kind,
        };
        let request = PersistRequest {
            expected_next_sequence: self.projection.next_sequence,
            event,
        };
        self.pending_persist = Some(request.clone());
        Ok(vec![Effect::Persist {
            request: Box::new(request),
        }])
    }

    fn require_manifest(&self) -> Result<&SessionManifest, KernelError> {
        self.projection
            .manifest
            .as_ref()
            .ok_or_else(|| KernelError::InvalidState {
                reason: "session is not created".to_owned(),
            })
    }

    fn require_active_turn(&self, turn_id: &TurnId) -> Result<&ActiveTurn, KernelError> {
        let active =
            self.projection
                .active_turn
                .as_ref()
                .ok_or_else(|| KernelError::InvalidState {
                    reason: "there is no active turn".to_owned(),
                })?;
        if active.turn_id != *turn_id {
            return Err(KernelError::StaleOperation {
                operation_id: OperationId::Inference {
                    session_id: self.require_manifest()?.session_id.clone(),
                    turn_id: turn_id.clone(),
                    step: 0,
                },
            });
        }
        Ok(active)
    }

    fn require_idle_for_command(&self) -> Result<(), KernelError> {
        self.require_no_pending_persist()?;
        if let Some(operation_id) = &self.in_flight {
            return Err(KernelError::InvalidState {
                reason: format!("operation {operation_id:?} is in flight"),
            });
        }
        Ok(())
    }

    fn require_no_pending_persist(&self) -> Result<(), KernelError> {
        if let Some(pending) = &self.pending_persist {
            return Err(KernelError::PersistenceInFlight {
                event_id: pending.event.event_id.clone(),
            });
        }
        Ok(())
    }

    fn require_in_flight(&self, operation_id: &OperationId) -> Result<(), KernelError> {
        if self.in_flight.as_ref() != Some(operation_id) {
            return Err(KernelError::StaleOperation {
                operation_id: operation_id.clone(),
            });
        }
        Ok(())
    }

    fn validate_failure(&self, failure: &TurnFailure) -> Result<(), KernelError> {
        let manifest = self.require_manifest()?;
        validate_bounded(
            "failure message",
            failure.message.len(),
            usize_from_u32(manifest.limits.max_message_bytes),
        )?;
        if failure.message.trim().is_empty() {
            return Err(KernelError::InvalidInput {
                reason: "failure message must not be empty".to_owned(),
            });
        }
        Ok(())
    }

    fn validate_tool_outcome(&self, outcome: &ToolOutcome) -> Result<(), KernelError> {
        let manifest = self.require_manifest()?;
        let size = match outcome {
            ToolOutcome::Succeeded { output } => output.len(),
            ToolOutcome::Failed { code, message, .. } => {
                validate_identifier("tool failure code", code)?;
                message.len()
            }
            ToolOutcome::Denied { reason } | ToolOutcome::Cancelled { reason, .. } => reason.len(),
        };
        validate_bounded(
            "tool outcome",
            size,
            usize_from_u32(manifest.limits.max_tool_payload_bytes),
        )
    }
}

impl Projection {
    fn apply_record(&mut self, record: &EventRecord) -> Result<(), KernelError> {
        if record.sequence != self.next_sequence {
            return Err(KernelError::SequenceMismatch {
                expected: self.next_sequence,
                found: record.sequence,
            });
        }
        validate_event_envelope(self, &record.event)?;
        if !self.seen_event_ids.insert(record.event.event_id.clone()) {
            return Err(KernelError::ReplayViolation {
                reason: format!("duplicate event ID {}", record.event.event_id),
            });
        }

        let turn_id = record.event.turn_id.clone();
        match &record.event.kind {
            EventKind::SessionCreated { manifest } => self.apply_session_created(manifest)?,
            EventKind::TurnRequested { message } => {
                self.apply_turn_requested(require_turn_id(turn_id)?, message)?;
            }
            EventKind::TurnCancellationRequested { reason } => {
                self.apply_cancellation_requested(&require_turn_id(turn_id)?, reason)?;
            }
            EventKind::InferenceStarted { step, operation_id } => {
                self.apply_inference_started(&require_turn_id(turn_id)?, *step, operation_id)?;
            }
            EventKind::AssistantMessageRecorded {
                step,
                operation_id,
                message,
            } => self.apply_assistant_message(
                require_turn_id(turn_id)?,
                *step,
                operation_id,
                message,
            )?,
            EventKind::ToolTerminalRecorded {
                step,
                call_index,
                operation_id,
                outcome,
            } => self.apply_tool_terminal(
                require_turn_id(turn_id)?,
                *step,
                *call_index,
                operation_id,
                outcome,
            )?,
            EventKind::TurnCompleted => {
                self.apply_turn_completed(require_turn_id(turn_id)?)?;
            }
            EventKind::TurnCancelled { reason, assistant } => {
                self.apply_turn_cancelled(require_turn_id(turn_id)?, reason, assistant)?;
            }
            EventKind::TurnFailed { failure, assistant } => {
                self.apply_turn_failed(require_turn_id(turn_id)?, failure, assistant)?;
            }
        }
        self.next_sequence =
            self.next_sequence
                .checked_add(1)
                .ok_or_else(|| KernelError::ReplayViolation {
                    reason: "event sequence overflow".to_owned(),
                })?;
        Ok(())
    }

    fn apply_session_created(&mut self, manifest: &SessionManifest) -> Result<(), KernelError> {
        if self.manifest.is_some() || self.next_sequence != 0 {
            return Err(KernelError::ReplayViolation {
                reason: "session.created must be the first and only creation event".to_owned(),
            });
        }
        validate_manifest(manifest)?;
        self.manifest = Some(manifest.clone());
        Ok(())
    }

    fn apply_turn_requested(
        &mut self,
        turn_id: TurnId,
        message: &UserMessage,
    ) -> Result<(), KernelError> {
        let max_message_bytes = require_projection_manifest(self)?.limits.max_message_bytes;
        if self.active_turn.is_some() {
            return Err(KernelError::ReplayViolation {
                reason: "turn.requested encountered while another turn is active".to_owned(),
            });
        }
        validate_identifier("turn_id", turn_id.as_str())?;
        if !self.seen_turn_ids.insert(turn_id.clone()) {
            return Err(KernelError::ReplayViolation {
                reason: format!("turn ID {turn_id} was reused"),
            });
        }
        if message.id != user_message_id(&turn_id) {
            return Err(KernelError::ReplayViolation {
                reason: "user message ID is not the deterministic turn message ID".to_owned(),
            });
        }
        validate_bounded(
            "user message",
            message.content.len(),
            usize_from_u32(max_message_bytes),
        )?;
        if message.content.trim().is_empty() {
            return Err(KernelError::ReplayViolation {
                reason: "user message is empty".to_owned(),
            });
        }
        if !matches!(
            self.transcript.last(),
            None | Some(TranscriptMessage::Assistant { .. })
        ) {
            return Err(KernelError::ReplayViolation {
                reason: "user role does not follow an assistant boundary".to_owned(),
            });
        }
        self.transcript.push(TranscriptMessage::User {
            turn_id: turn_id.clone(),
            message: message.clone(),
        });
        self.active_turn = Some(ActiveTurn {
            turn_id,
            steps_started: 0,
            current_inference: None,
            assistant_step: None,
            cancellation_reason: None,
        });
        Ok(())
    }

    fn apply_cancellation_requested(
        &mut self,
        turn_id: &TurnId,
        reason: &str,
    ) -> Result<(), KernelError> {
        let manifest = require_projection_manifest(self)?;
        validate_bounded(
            "cancellation reason",
            reason.len(),
            usize_from_u32(manifest.limits.max_message_bytes),
        )?;
        if reason.trim().is_empty() {
            return Err(KernelError::ReplayViolation {
                reason: "cancellation reason is empty".to_owned(),
            });
        }
        let active = require_projection_active(self, turn_id)?;
        if active.cancellation_reason.is_some() {
            return Err(KernelError::ReplayViolation {
                reason: "turn has more than one cancellation request".to_owned(),
            });
        }
        active.cancellation_reason = Some(reason.to_owned());
        active.current_inference = None;
        Ok(())
    }

    fn apply_inference_started(
        &mut self,
        turn_id: &TurnId,
        step: u32,
        operation_id: &OperationId,
    ) -> Result<(), KernelError> {
        let manifest = require_projection_manifest(self)?.clone();
        let active = require_projection_active(self, turn_id)?;
        if active.cancellation_reason.is_some() || active.current_inference.is_some() {
            return Err(KernelError::ReplayViolation {
                reason: "inference started while cancelled or already running".to_owned(),
            });
        }
        if step != active.steps_started + 1 || step > manifest.limits.max_steps {
            return Err(KernelError::ReplayViolation {
                reason: format!(
                    "invalid inference step {step}; previous={}, max={}",
                    active.steps_started, manifest.limits.max_steps
                ),
            });
        }
        if let Some(assistant) = &active.assistant_step {
            if assistant.calls.is_empty() || !assistant.is_resolved() {
                return Err(KernelError::ReplayViolation {
                    reason: "new inference started before the prior assistant/tool phase resolved"
                        .to_owned(),
                });
            }
        }
        let expected = inference_operation_id(&manifest.session_id, turn_id, step);
        if *operation_id != expected {
            return Err(KernelError::ReplayViolation {
                reason: "inference operation ID does not match session/turn/step".to_owned(),
            });
        }
        active.assistant_step = None;
        active.steps_started = step;
        active.current_inference = Some(operation_id.clone());
        Ok(())
    }

    fn apply_assistant_message(
        &mut self,
        turn_id: TurnId,
        step: u32,
        operation_id: &OperationId,
        message: &AssistantMessage,
    ) -> Result<(), KernelError> {
        let manifest = require_projection_manifest(self)?.clone();
        validate_bounded(
            "assistant content",
            message.content.len(),
            usize_from_u32(manifest.limits.max_message_bytes),
        )?;
        validate_bounded(
            "tool call count",
            message.tool_calls.len(),
            usize_from_u32(manifest.limits.max_tool_calls_per_step),
        )?;
        if message.content.is_empty() && message.tool_calls.is_empty() {
            return Err(KernelError::ReplayViolation {
                reason: "assistant message has neither text nor tool calls".to_owned(),
            });
        }
        if message.id != assistant_message_id(&turn_id, step) {
            return Err(KernelError::ReplayViolation {
                reason: "assistant message ID is not deterministic".to_owned(),
            });
        }
        validate_tool_calls(&manifest, &message.tool_calls, &self.seen_tool_call_ids)?;

        let active = require_projection_active(self, &turn_id)?;
        if active.cancellation_reason.is_some()
            || active.steps_started != step
            || active.current_inference.as_ref() != Some(operation_id)
        {
            return Err(KernelError::ReplayViolation {
                reason: "assistant message does not match the active inference".to_owned(),
            });
        }
        active.current_inference = None;
        active.assistant_step = Some(AssistantStep {
            step,
            calls: message.tool_calls.clone(),
            next_terminal_index: 0,
        });
        for call in &message.tool_calls {
            self.seen_tool_call_ids.insert(call.id.clone());
        }
        self.transcript.push(TranscriptMessage::Assistant {
            turn_id,
            step,
            message: message.clone(),
        });
        Ok(())
    }

    fn apply_tool_terminal(
        &mut self,
        turn_id: TurnId,
        step: u32,
        call_index: u32,
        operation_id: &OperationId,
        outcome: &ToolOutcome,
    ) -> Result<(), KernelError> {
        let manifest = require_projection_manifest(self)?.clone();
        validate_tool_outcome_with_manifest(&manifest, outcome)?;
        let (expected_call_id, expected_call_name) = {
            let active = require_projection_active(self, &turn_id)?;
            let cancellation_requested = active.cancellation_reason.is_some();
            let assistant =
                active
                    .assistant_step
                    .as_mut()
                    .ok_or_else(|| KernelError::ReplayViolation {
                        reason: "tool result has no preceding assistant tool request".to_owned(),
                    })?;
            let (expected_index, expected_call) =
                assistant
                    .unresolved_call()
                    .ok_or_else(|| KernelError::ReplayViolation {
                        reason: "tool call already has a terminal result".to_owned(),
                    })?;
            if assistant.step != step || expected_index != usize_from_u32(call_index) {
                return Err(KernelError::ReplayViolation {
                    reason: format!(
                        "tool result is out of order: expected index {expected_index}, found {call_index}"
                    ),
                });
            }
            let expected_operation = tool_operation_id(
                &manifest.session_id,
                &turn_id,
                step,
                call_index,
                &expected_call.id,
            );
            if *operation_id != expected_operation {
                return Err(KernelError::ReplayViolation {
                    reason: "tool operation does not match the requested call".to_owned(),
                });
            }
            if cancellation_requested && !matches!(outcome, ToolOutcome::Cancelled { .. }) {
                return Err(KernelError::ReplayViolation {
                    reason: "only cancelled tool terminals may follow cancellation".to_owned(),
                });
            }
            let call = (expected_call.id.clone(), expected_call.name.clone());
            assistant.next_terminal_index += 1;
            call
        };
        self.transcript.push(TranscriptMessage::Tool {
            turn_id,
            step,
            call_index,
            call_id: expected_call_id,
            name: expected_call_name,
            outcome: outcome.clone(),
        });
        Ok(())
    }

    fn apply_turn_completed(&mut self, turn_id: TurnId) -> Result<(), KernelError> {
        let active = require_projection_active(self, &turn_id)?;
        let assistant =
            active
                .assistant_step
                .as_ref()
                .ok_or_else(|| KernelError::ReplayViolation {
                    reason: "turn completed without an assistant message".to_owned(),
                })?;
        if active.cancellation_reason.is_some()
            || active.current_inference.is_some()
            || !assistant.calls.is_empty()
        {
            return Err(KernelError::ReplayViolation {
                reason: "turn completed with unresolved inference, cancellation, or tool calls"
                    .to_owned(),
            });
        }
        self.active_turn = None;
        self.last_terminal = Some((turn_id, TurnTerminal::Completed));
        Ok(())
    }

    fn apply_turn_cancelled(
        &mut self,
        turn_id: TurnId,
        reason: &str,
        assistant: &AssistantMessage,
    ) -> Result<(), KernelError> {
        let transcript_step = {
            let active = require_projection_active(self, &turn_id)?;
            if active.cancellation_reason.as_deref() != Some(reason)
                || active.current_inference.is_some()
                || active
                    .assistant_step
                    .as_ref()
                    .is_some_and(|step| !step.is_resolved())
            {
                return Err(KernelError::ReplayViolation {
                    reason: "turn.cancelled does not follow a fully resolved cancellation"
                        .to_owned(),
                });
            }
            active.steps_started.saturating_add(1)
        };
        validate_terminal_assistant(&turn_id, "cancelled", assistant)?;
        self.transcript.push(TranscriptMessage::Assistant {
            turn_id: turn_id.clone(),
            step: transcript_step,
            message: assistant.clone(),
        });
        self.active_turn = None;
        self.last_terminal = Some((
            turn_id,
            TurnTerminal::Cancelled {
                reason: reason.to_owned(),
            },
        ));
        Ok(())
    }

    fn apply_turn_failed(
        &mut self,
        turn_id: TurnId,
        failure: &TurnFailure,
        assistant: &AssistantMessage,
    ) -> Result<(), KernelError> {
        let manifest = require_projection_manifest(self)?.clone();
        validate_failure_with_manifest(&manifest, failure)?;
        let transcript_step = {
            let active = require_projection_active(self, &turn_id)?;
            if active.cancellation_reason.is_some()
                || active
                    .assistant_step
                    .as_ref()
                    .is_some_and(|step| !step.is_resolved())
            {
                return Err(KernelError::ReplayViolation {
                    reason: "turn failed with unresolved tool calls or cancellation".to_owned(),
                });
            }
            if failure.code == FailureCode::StepLimitExceeded
                && active.steps_started < manifest.limits.max_steps
            {
                return Err(KernelError::ReplayViolation {
                    reason: "step-limit failure occurred before the pinned cap".to_owned(),
                });
            }
            active.steps_started.saturating_add(1)
        };
        validate_terminal_assistant(&turn_id, "failed", assistant)?;
        self.transcript.push(TranscriptMessage::Assistant {
            turn_id: turn_id.clone(),
            step: transcript_step,
            message: assistant.clone(),
        });
        self.active_turn = None;
        self.last_terminal = Some((
            turn_id,
            TurnTerminal::Failed {
                failure: failure.clone(),
            },
        ));
        Ok(())
    }
}

fn validate_event_envelope(
    projection: &Projection,
    event: &DurableEvent,
) -> Result<(), KernelError> {
    if event.schema_version != SCHEMA_VERSION {
        return Err(KernelError::UnsupportedSchemaVersion {
            found: event.schema_version,
        });
    }
    match (&projection.manifest, &event.kind) {
        (None, EventKind::SessionCreated { manifest }) => {
            if event.session_id != manifest.session_id || event.turn_id.is_some() {
                return Err(KernelError::ReplayViolation {
                    reason: "session.created envelope does not match its manifest".to_owned(),
                });
            }
        }
        (None, _) => {
            return Err(KernelError::ReplayViolation {
                reason: "session.created must precede every other event".to_owned(),
            });
        }
        (Some(_manifest), EventKind::SessionCreated { .. }) => {
            return Err(KernelError::ReplayViolation {
                reason: "session.created may appear only once".to_owned(),
            });
        }
        (Some(manifest), _) => {
            if event.session_id != manifest.session_id {
                return Err(KernelError::ReplayViolation {
                    reason: "event belongs to a different session".to_owned(),
                });
            }
            let turn_id = event
                .turn_id
                .as_ref()
                .ok_or_else(|| KernelError::ReplayViolation {
                    reason: "turn event is missing turnId".to_owned(),
                })?;
            if let Some(operation_turn) = event.kind.turn_id_hint() {
                if operation_turn != turn_id {
                    return Err(KernelError::ReplayViolation {
                        reason: "event turnId differs from its operation turn".to_owned(),
                    });
                }
            }
        }
    }
    let expected = expected_event_id(&event.session_id, event.turn_id.as_ref(), &event.kind)?;
    if event.event_id != expected {
        return Err(KernelError::ReplayViolation {
            reason: format!(
                "event ID {} is not the deterministic ID {expected}",
                event.event_id
            ),
        });
    }
    Ok(())
}

/// Validate the complete immutable session contract.
///
/// # Errors
///
/// Returns [`KernelError`] when the version, identifiers, digests, limits,
/// canonical schemas, or ordered tool set are invalid.
pub fn validate_manifest(manifest: &SessionManifest) -> Result<(), KernelError> {
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(KernelError::UnsupportedSchemaVersion {
            found: manifest.schema_version,
        });
    }
    validate_identifier("session_id", manifest.session_id.as_str())?;
    validate_nonempty_bounded("manifest_digest", &manifest.manifest_digest)?;
    validate_nonempty_bounded("system_prompt_digest", &manifest.system_prompt_digest)?;
    validate_nonempty_bounded("tool_manifest_digest", &manifest.tool_manifest_digest)?;
    validate_nonempty_bounded(
        "extension_manifest_digest",
        &manifest.extension_manifest_digest,
    )?;
    validate_nonempty_bounded("provider", &manifest.model.provider)?;
    validate_nonempty_bounded("model", &manifest.model.model)?;
    validate_nonempty_bounded("compatibility_mode", &manifest.model.compatibility_mode)?;
    validate_nonempty_bounded("capability_tier", &manifest.capability_tier)?;
    validate_bounded(
        "system prompt",
        manifest.system_prompt.len(),
        MAX_MANIFEST_TEXT_BYTES,
    )?;
    if manifest.limits.max_steps == 0
        || manifest.limits.max_tool_calls_per_step == 0
        || manifest.limits.max_message_bytes == 0
        || manifest.limits.max_tool_payload_bytes == 0
    {
        return Err(KernelError::InvalidManifest {
            reason: "all runtime limits must be greater than zero".to_owned(),
        });
    }
    let mut names = BTreeSet::new();
    for tool in &manifest.tools {
        validate_nonempty_bounded("tool name", &tool.name)?;
        validate_nonempty_bounded("tool schema digest", &tool.schema_digest)?;
        if tool.schema_json.trim().is_empty() {
            return Err(KernelError::InvalidManifest {
                reason: format!("tool {} has an empty canonical schema", tool.name),
            });
        }
        validate_bounded(
            "tool schema",
            tool.schema_json.len(),
            MAX_MANIFEST_TEXT_BYTES,
        )?;
        if !names.insert(tool.name.clone()) {
            return Err(KernelError::InvalidManifest {
                reason: format!("duplicate pinned tool {}", tool.name),
            });
        }
    }
    Ok(())
}

fn validate_tool_calls(
    manifest: &SessionManifest,
    calls: &[ToolCall],
    prior_call_ids: &BTreeSet<ToolCallId>,
) -> Result<(), KernelError> {
    let pinned_names: BTreeSet<&str> = manifest
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect();
    let mut current_ids = BTreeSet::new();
    for call in calls {
        validate_identifier("tool call ID", call.id.as_str())?;
        validate_nonempty_bounded("tool call name", &call.name)?;
        if !pinned_names.contains(call.name.as_str()) {
            return Err(KernelError::InvalidInput {
                reason: format!("tool {} is not in the pinned manifest", call.name),
            });
        }
        validate_bounded(
            "tool arguments",
            call.arguments_json.len(),
            usize_from_u32(manifest.limits.max_tool_payload_bytes),
        )?;
        if call.arguments_json.trim().is_empty() {
            return Err(KernelError::InvalidInput {
                reason: format!("tool {} has empty canonical arguments", call.name),
            });
        }
        if prior_call_ids.contains(&call.id) || !current_ids.insert(call.id.clone()) {
            return Err(KernelError::InvalidInput {
                reason: format!("duplicate tool call ID {}", call.id),
            });
        }
    }
    Ok(())
}

fn validate_tool_outcome_with_manifest(
    manifest: &SessionManifest,
    outcome: &ToolOutcome,
) -> Result<(), KernelError> {
    let size = match outcome {
        ToolOutcome::Succeeded { output } => output.len(),
        ToolOutcome::Failed { code, message, .. } => {
            validate_identifier("tool failure code", code)?;
            message.len()
        }
        ToolOutcome::Denied { reason } | ToolOutcome::Cancelled { reason, .. } => reason.len(),
    };
    validate_bounded(
        "tool outcome",
        size,
        usize_from_u32(manifest.limits.max_tool_payload_bytes),
    )
}

fn validate_failure_with_manifest(
    manifest: &SessionManifest,
    failure: &TurnFailure,
) -> Result<(), KernelError> {
    validate_bounded(
        "failure message",
        failure.message.len(),
        usize_from_u32(manifest.limits.max_message_bytes),
    )?;
    if failure.message.trim().is_empty() {
        return Err(KernelError::ReplayViolation {
            reason: "failure message is empty".to_owned(),
        });
    }
    Ok(())
}

fn validate_terminal_assistant(
    turn_id: &TurnId,
    suffix: &str,
    assistant: &AssistantMessage,
) -> Result<(), KernelError> {
    if assistant.id != terminal_message_id(turn_id, suffix)
        || assistant.content.trim().is_empty()
        || !assistant.tool_calls.is_empty()
    {
        return Err(KernelError::ReplayViolation {
            reason: format!("invalid kernel terminal assistant message for {suffix}"),
        });
    }
    Ok(())
}

fn require_projection_manifest(projection: &Projection) -> Result<&SessionManifest, KernelError> {
    projection
        .manifest
        .as_ref()
        .ok_or_else(|| KernelError::ReplayViolation {
            reason: "session manifest is missing".to_owned(),
        })
}

fn require_projection_active<'a>(
    projection: &'a mut Projection,
    turn_id: &TurnId,
) -> Result<&'a mut ActiveTurn, KernelError> {
    let active = projection
        .active_turn
        .as_mut()
        .ok_or_else(|| KernelError::ReplayViolation {
            reason: "event has no active turn".to_owned(),
        })?;
    if active.turn_id != *turn_id {
        return Err(KernelError::ReplayViolation {
            reason: format!(
                "event targets turn {turn_id}, but {} is active",
                active.turn_id
            ),
        });
    }
    Ok(active)
}

fn require_turn_id(turn_id: Option<TurnId>) -> Result<TurnId, KernelError> {
    turn_id.ok_or_else(|| KernelError::ReplayViolation {
        reason: "turn event is missing turnId".to_owned(),
    })
}

fn inference_parts(operation_id: &OperationId) -> Result<(SessionId, TurnId, u32), KernelError> {
    match operation_id {
        OperationId::Inference {
            session_id,
            turn_id,
            step,
        } => Ok((session_id.clone(), turn_id.clone(), *step)),
        OperationId::Tool { .. } => Err(KernelError::StaleOperation {
            operation_id: operation_id.clone(),
        }),
    }
}

fn tool_parts(
    operation_id: &OperationId,
) -> Result<(SessionId, TurnId, u32, u32, ToolCallId), KernelError> {
    match operation_id {
        OperationId::Tool {
            session_id,
            turn_id,
            step,
            call_index,
            call_id,
        } => Ok((
            session_id.clone(),
            turn_id.clone(),
            *step,
            *call_index,
            call_id.clone(),
        )),
        OperationId::Inference { .. } => Err(KernelError::StaleOperation {
            operation_id: operation_id.clone(),
        }),
    }
}

fn inference_operation_id(session_id: &SessionId, turn_id: &TurnId, step: u32) -> OperationId {
    OperationId::Inference {
        session_id: session_id.clone(),
        turn_id: turn_id.clone(),
        step,
    }
}

fn tool_operation_id(
    session_id: &SessionId,
    turn_id: &TurnId,
    step: u32,
    call_index: u32,
    call_id: &ToolCallId,
) -> OperationId {
    OperationId::Tool {
        session_id: session_id.clone(),
        turn_id: turn_id.clone(),
        step,
        call_index,
        call_id: call_id.clone(),
    }
}

fn terminal_from_event(event: &DurableEvent) -> Option<(TurnId, TurnTerminal)> {
    let turn_id = event.turn_id.clone()?;
    match &event.kind {
        EventKind::TurnCompleted => Some((turn_id, TurnTerminal::Completed)),
        EventKind::TurnCancelled { reason, .. } => Some((
            turn_id,
            TurnTerminal::Cancelled {
                reason: reason.clone(),
            },
        )),
        EventKind::TurnFailed { failure, .. } => Some((
            turn_id,
            TurnTerminal::Failed {
                failure: failure.clone(),
            },
        )),
        _ => None,
    }
}

fn expected_event_id(
    session_id: &SessionId,
    turn_id: Option<&TurnId>,
    kind: &EventKind,
) -> Result<EventId, KernelError> {
    let session_scope = length_scoped(session_id.as_str());
    let value = match kind {
        EventKind::SessionCreated { .. } => format!("session/{session_scope}/created"),
        EventKind::TurnRequested { .. } => {
            format!("turn/{}/requested", turn_scope(turn_id)?)
        }
        EventKind::TurnCancellationRequested { .. } => {
            format!("turn/{}/cancellation-requested", turn_scope(turn_id)?)
        }
        EventKind::InferenceStarted { step, .. } => {
            format!("turn/{}/inference/{step}/started", turn_scope(turn_id)?)
        }
        EventKind::AssistantMessageRecorded { step, .. } => {
            format!("turn/{}/assistant/{step}", turn_scope(turn_id)?)
        }
        EventKind::ToolTerminalRecorded {
            step, call_index, ..
        } => format!(
            "turn/{}/tool/{step}/{call_index}/terminal",
            turn_scope(turn_id)?
        ),
        EventKind::TurnCompleted => format!("turn/{}/completed", turn_scope(turn_id)?),
        EventKind::TurnCancelled { .. } => {
            format!("turn/{}/cancelled", turn_scope(turn_id)?)
        }
        EventKind::TurnFailed { .. } => format!("turn/{}/failed", turn_scope(turn_id)?),
    };
    Ok(EventId::new(value))
}

fn turn_scope(turn_id: Option<&TurnId>) -> Result<String, KernelError> {
    turn_id
        .map(|turn_id| length_scoped(turn_id.as_str()))
        .ok_or_else(|| KernelError::InvalidInput {
            reason: "turn event requires turn_id".to_owned(),
        })
}

fn length_scoped(value: &str) -> String {
    format!("{}:{value}", value.len())
}

fn user_message_id(turn_id: &TurnId) -> MessageId {
    MessageId::new(format!("user/{}", length_scoped(turn_id.as_str())))
}

fn assistant_message_id(turn_id: &TurnId, step: u32) -> MessageId {
    MessageId::new(format!(
        "assistant/{}/{step}",
        length_scoped(turn_id.as_str())
    ))
}

fn terminal_message_id(turn_id: &TurnId, suffix: &str) -> MessageId {
    MessageId::new(format!(
        "kernel/{}/{suffix}",
        length_scoped(turn_id.as_str())
    ))
}

fn terminal_assistant_message(turn_id: &TurnId, suffix: &str, content: String) -> AssistantMessage {
    AssistantMessage {
        id: terminal_message_id(turn_id, suffix),
        content,
        tool_calls: Vec::new(),
    }
}

fn validate_identifier(label: &'static str, value: &str) -> Result<(), KernelError> {
    if value.trim().is_empty() {
        return Err(KernelError::InvalidInput {
            reason: format!("{label} must not be empty"),
        });
    }
    validate_bounded(label, value.len(), MAX_IDENTIFIER_BYTES)
}

fn validate_nonempty_bounded(label: &'static str, value: &str) -> Result<(), KernelError> {
    if value.trim().is_empty() {
        return Err(KernelError::InvalidManifest {
            reason: format!("{label} must not be empty"),
        });
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(KernelError::InvalidManifest {
            reason: format!("{label} exceeds {MAX_IDENTIFIER_BYTES} bytes"),
        });
    }
    Ok(())
}

fn validate_bounded(field: &'static str, actual: usize, limit: usize) -> Result<(), KernelError> {
    if actual > limit {
        return Err(KernelError::LimitExceeded {
            field,
            limit,
            actual,
        });
    }
    Ok(())
}

fn usize_from_u32(value: u32) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}

fn u32_from_usize(value: usize) -> Result<u32, KernelError> {
    u32::try_from(value).map_err(|_| KernelError::InvalidState {
        reason: "tool call index exceeds u32".to_owned(),
    })
}
