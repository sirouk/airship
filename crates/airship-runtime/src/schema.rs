use core::fmt;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u16 = 1;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(
            Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            #[must_use]
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self::new(value)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self::new(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

string_id!(SessionId);
string_id!(TurnId);
string_id!(ToolCallId);
string_id!(EventId);
string_id!(MessageId);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLimits {
    pub max_steps: u32,
    pub max_tool_calls_per_step: u32,
    pub max_message_bytes: u32,
    pub max_tool_payload_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPin {
    pub provider: String,
    pub model: String,
    pub compatibility_mode: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolEffectClass {
    Read,
    Write,
    Network,
    Execute,
    Identity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPin {
    pub name: String,
    /// Canonical JSON bytes represented as UTF-8. The host owns canonicalization.
    pub schema_json: String,
    pub schema_digest: String,
    pub effect: ToolEffectClass,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    #[serde(rename = "v")]
    pub schema_version: u16,
    pub session_id: SessionId,
    /// Digest of the complete canonical manifest, computed by the host.
    pub manifest_digest: String,
    /// Exact bytes used as the system prefix for this session.
    pub system_prompt: String,
    pub system_prompt_digest: String,
    pub model: ModelPin,
    /// Canonically ordered and frozen for the lifetime of the session.
    pub tools: Vec<ToolPin>,
    pub tool_manifest_digest: String,
    pub extension_manifest_digest: String,
    pub capability_tier: String,
    pub limits: RuntimeLimits,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub id: MessageId,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: ToolCallId,
    pub name: String,
    /// Canonical JSON bytes represented as UTF-8. The transport owns conversion.
    pub arguments_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub id: MessageId,
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ToolOutcome {
    Succeeded {
        output: String,
    },
    Failed {
        code: String,
        message: String,
        retryable: bool,
    },
    Denied {
        reason: String,
    },
    /// Cancellation cannot prove that an already-started side effect did not occur.
    Cancelled {
        reason: String,
        outcome_unknown: bool,
    },
}

impl ToolOutcome {
    #[must_use]
    pub fn model_content(&self) -> String {
        match self {
            Self::Succeeded { output } => output.clone(),
            Self::Failed {
                code,
                message,
                retryable,
            } => format!("tool failed ({code}, retryable={retryable}): {message}"),
            Self::Denied { reason } => format!("tool denied: {reason}"),
            Self::Cancelled {
                reason,
                outcome_unknown,
            } => format!("tool cancelled (outcome_unknown={outcome_unknown}): {reason}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum TranscriptMessage {
    User {
        turn_id: TurnId,
        message: UserMessage,
    },
    Assistant {
        turn_id: TurnId,
        step: u32,
        message: AssistantMessage,
    },
    Tool {
        turn_id: TurnId,
        step: u32,
        call_index: u32,
        call_id: ToolCallId,
        name: String,
        outcome: ToolOutcome,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum OperationId {
    Inference {
        session_id: SessionId,
        turn_id: TurnId,
        step: u32,
    },
    Tool {
        session_id: SessionId,
        turn_id: TurnId,
        step: u32,
        call_index: u32,
        call_id: ToolCallId,
    },
}

impl OperationId {
    #[must_use]
    pub fn turn_id(&self) -> &TurnId {
        match self {
            Self::Inference { turn_id, .. } | Self::Tool { turn_id, .. } => turn_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureCode {
    Provider,
    Protocol,
    StepLimitExceeded,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFailure {
    pub code: FailureCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum TurnTerminal {
    Completed,
    Cancelled { reason: String },
    Failed { failure: TurnFailure },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EventKind {
    #[serde(rename = "session.created")]
    SessionCreated { manifest: SessionManifest },
    #[serde(rename = "turn.requested")]
    TurnRequested { message: UserMessage },
    #[serde(rename = "turn.cancellation-requested")]
    TurnCancellationRequested { reason: String },
    #[serde(rename = "inference.started")]
    InferenceStarted {
        step: u32,
        operation_id: OperationId,
    },
    /// A tool request becomes durable as part of this assistant message.
    #[serde(rename = "assistant.completed")]
    AssistantMessageRecorded {
        step: u32,
        operation_id: OperationId,
        message: AssistantMessage,
    },
    #[serde(rename = "tool.resulted")]
    ToolTerminalRecorded {
        step: u32,
        call_index: u32,
        operation_id: OperationId,
        outcome: ToolOutcome,
    },
    #[serde(rename = "turn.completed")]
    TurnCompleted,
    #[serde(rename = "turn.cancelled")]
    TurnCancelled {
        reason: String,
        assistant: AssistantMessage,
    },
    #[serde(rename = "turn.failed")]
    TurnFailed {
        failure: TurnFailure,
        assistant: AssistantMessage,
    },
}

impl EventKind {
    #[must_use]
    pub fn turn_id_hint(&self) -> Option<&TurnId> {
        match self {
            Self::InferenceStarted { operation_id, .. }
            | Self::AssistantMessageRecorded { operation_id, .. }
            | Self::ToolTerminalRecorded { operation_id, .. } => Some(operation_id.turn_id()),
            Self::SessionCreated { .. }
            | Self::TurnRequested { .. }
            | Self::TurnCancellationRequested { .. }
            | Self::TurnCompleted
            | Self::TurnCancelled { .. }
            | Self::TurnFailed { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableEvent {
    #[serde(rename = "v")]
    pub schema_version: u16,
    pub event_id: EventId,
    pub session_id: SessionId,
    pub turn_id: Option<TurnId>,
    pub kind: EventKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub sequence: u64,
    pub event: DurableEvent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistRequest {
    pub expected_next_sequence: u64,
    pub event: DurableEvent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceRequest {
    pub operation_id: OperationId,
    pub manifest_digest: String,
    pub system_prompt: String,
    pub model: ModelPin,
    pub tools: Vec<ToolPin>,
    pub messages: Vec<TranscriptMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvocation {
    pub operation_id: OperationId,
    pub call: ToolCall,
    pub effect: ToolEffectClass,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Effect {
    #[serde(rename = "state.persist")]
    Persist { request: Box<PersistRequest> },
    #[serde(rename = "inference.start")]
    StartInference { request: Box<InferenceRequest> },
    #[serde(rename = "inference.resume")]
    ResumeInference { request: Box<InferenceRequest> },
    #[serde(rename = "tool.execute")]
    ExecuteTool { invocation: ToolInvocation },
    #[serde(rename = "tool.recover")]
    RecoverTool { invocation: ToolInvocation },
    #[serde(rename = "operation.cancel")]
    CancelOperation { operation_id: OperationId },
    #[serde(rename = "turn.finalized")]
    TurnFinalized {
        turn_id: TurnId,
        terminal: TurnTerminal,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "session.create")]
    CreateSession { manifest: Box<SessionManifest> },
    #[serde(rename = "turn.start")]
    StartTurn { turn_id: TurnId, content: String },
    #[serde(rename = "turn.cancel")]
    CancelTurn { turn_id: TurnId, reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantOutput {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EffectResult {
    #[serde(rename = "state.persisted")]
    Persisted { record: Box<EventRecord> },
    #[serde(rename = "state.persistence-failed")]
    PersistenceFailed {
        event_id: EventId,
        retryable: bool,
        message: String,
    },
    #[serde(rename = "inference.completed")]
    InferenceCompleted {
        operation_id: OperationId,
        output: AssistantOutput,
    },
    #[serde(rename = "inference.failed")]
    InferenceFailed {
        operation_id: OperationId,
        failure: TurnFailure,
    },
    #[serde(rename = "tool.completed")]
    ToolCompleted {
        operation_id: OperationId,
        outcome: ToolOutcome,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", content = "input", rename_all = "kebab-case")]
pub enum KernelInput {
    Command(Command),
    EffectResult(EffectResult),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum KernelStatus {
    Uninitialized,
    Ready,
    /// Durable work exists, but recovery has not yet re-issued its stable effect.
    Recoverable {
        turn_id: TurnId,
    },
    Persisting {
        event_id: EventId,
    },
    Inferring {
        operation_id: OperationId,
    },
    ExecutingTool {
        operation_id: OperationId,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub effects: Vec<Effect>,
    pub status: KernelStatus,
}
