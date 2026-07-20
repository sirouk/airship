#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

//! Pure deterministic kernel for bounded Airship agent turns.
//!
//! The kernel emits data-only [`Effect`] values. A host must durably commit
//! [`Effect::Persist`] before acknowledging it, and only a matching
//! [`EffectResult::Persisted`] can unlock inference or tool execution.
//! Replaying committed [`EventRecord`] values reconstructs the same transcript
//! and stable operation identifiers without consulting clocks or randomness.

mod kernel;
mod schema;

pub use kernel::{validate_manifest, Kernel, KernelError};
pub use schema::{
    AssistantMessage, AssistantOutput, Command, DurableEvent, Effect, EffectResult, EventId,
    EventKind, EventRecord, FailureCode, InferenceRequest, KernelInput, KernelStatus, MessageId,
    ModelPin, OperationId, PersistRequest, RuntimeLimits, SessionId, SessionManifest, ToolCall,
    ToolCallId, ToolEffectClass, ToolInvocation, ToolOutcome, ToolPin, TranscriptMessage,
    Transition, TurnFailure, TurnId, TurnTerminal, UserMessage, SCHEMA_VERSION,
};
