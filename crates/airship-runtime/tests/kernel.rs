use airship_runtime::{
    validate_manifest, AssistantOutput, Command, Effect, EffectResult, EventKind, EventRecord,
    FailureCode, Kernel, KernelError, KernelInput, ModelPin, OperationId, PersistRequest,
    RuntimeLimits, SessionId, SessionManifest, ToolCall, ToolCallId, ToolEffectClass, ToolOutcome,
    ToolPin, TranscriptMessage, TurnFailure, TurnId, TurnTerminal, SCHEMA_VERSION,
};

fn manifest(max_steps: u32) -> SessionManifest {
    SessionManifest {
        schema_version: SCHEMA_VERSION,
        session_id: SessionId::from("session-1"),
        manifest_digest: "sha256:manifest-1".to_owned(),
        system_prompt: "You are Airship.".to_owned(),
        system_prompt_digest: "sha256:prompt-1".to_owned(),
        model: ModelPin {
            provider: "deterministic".to_owned(),
            model: "fixture-v1".to_owned(),
            compatibility_mode: "openai-chat-v1".to_owned(),
        },
        tools: vec![ToolPin {
            name: "lookup".to_owned(),
            schema_json: r#"{"type":"object"}"#.to_owned(),
            schema_digest: "sha256:lookup-schema".to_owned(),
            effect: ToolEffectClass::Read,
        }],
        tool_manifest_digest: "sha256:tools-1".to_owned(),
        extension_manifest_digest: "sha256:extensions-empty".to_owned(),
        capability_tier: "web-baseline".to_owned(),
        limits: RuntimeLimits {
            max_steps,
            max_tool_calls_per_step: 8,
            max_message_bytes: 16 * 1024,
            max_tool_payload_bytes: 16 * 1024,
        },
    }
}

fn command(kernel: &mut Kernel, command: Command) -> airship_runtime::Transition {
    kernel
        .transition(KernelInput::Command(command))
        .expect("command should be accepted")
}

fn result(kernel: &mut Kernel, effect_result: EffectResult) -> airship_runtime::Transition {
    kernel
        .transition(KernelInput::EffectResult(effect_result))
        .expect("effect result should be accepted")
}

fn persist_request(transition: &airship_runtime::Transition) -> PersistRequest {
    transition
        .effects
        .iter()
        .find_map(|effect| match effect {
            Effect::Persist { request } => Some((**request).clone()),
            _ => None,
        })
        .expect("transition should request persistence")
}

fn commit(
    kernel: &mut Kernel,
    log: &mut Vec<EventRecord>,
    transition: &airship_runtime::Transition,
) -> airship_runtime::Transition {
    let request = persist_request(transition);
    let record = EventRecord {
        sequence: request.expected_next_sequence,
        event: request.event,
    };
    log.push(record.clone());
    result(
        kernel,
        EffectResult::Persisted {
            record: Box::new(record),
        },
    )
}

fn inference_operation(transition: &airship_runtime::Transition) -> OperationId {
    transition
        .effects
        .iter()
        .find_map(|effect| match effect {
            Effect::StartInference { request } | Effect::ResumeInference { request } => {
                Some(request.operation_id.clone())
            }
            _ => None,
        })
        .expect("transition should start or resume inference")
}

fn tool_operation(transition: &airship_runtime::Transition) -> OperationId {
    transition
        .effects
        .iter()
        .find_map(|effect| match effect {
            Effect::ExecuteTool { invocation } | Effect::RecoverTool { invocation } => {
                Some(invocation.operation_id.clone())
            }
            _ => None,
        })
        .expect("transition should execute or recover a tool")
}

fn call(id: &str) -> ToolCall {
    ToolCall {
        id: ToolCallId::from(id),
        name: "lookup".to_owned(),
        arguments_json: format!(r#"{{"id":"{id}"}}"#),
    }
}

struct Harness {
    kernel: Kernel,
    log: Vec<EventRecord>,
}

impl Harness {
    fn created(max_steps: u32) -> Self {
        let mut harness = Self {
            kernel: Kernel::new(),
            log: Vec::new(),
        };
        let transition = command(
            &mut harness.kernel,
            Command::CreateSession {
                manifest: Box::new(manifest(max_steps)),
            },
        );
        let after = commit(&mut harness.kernel, &mut harness.log, &transition);
        assert!(after.effects.is_empty());
        harness
    }

    fn start_to_inference(&mut self, turn: &str) -> (TurnId, OperationId) {
        let turn_id = TurnId::from(turn);
        let requested = command(
            &mut self.kernel,
            Command::StartTurn {
                turn_id: turn_id.clone(),
                content: "do the work".to_owned(),
            },
        );
        assert!(requested
            .effects
            .iter()
            .all(|effect| matches!(effect, Effect::Persist { .. })));
        let inference_intent = commit(&mut self.kernel, &mut self.log, &requested);
        assert!(matches!(
            persist_request(&inference_intent).event.kind,
            EventKind::InferenceStarted { step: 1, .. }
        ));
        let inference = commit(&mut self.kernel, &mut self.log, &inference_intent);
        let operation = inference_operation(&inference);
        (turn_id, operation)
    }
}

#[test]
fn durable_user_and_inference_intents_gate_network_execution() {
    let mut harness = Harness::created(4);
    let (turn_id, operation) = harness.start_to_inference("turn-1");

    assert_eq!(operation.turn_id(), &turn_id);
    assert_eq!(harness.log.len(), 3);
    assert!(matches!(
        harness.log[1].event.kind,
        EventKind::TurnRequested { .. }
    ));
    assert!(matches!(
        harness.log[2].event.kind,
        EventKind::InferenceStarted { .. }
    ));
}

#[test]
fn assistant_tool_intent_is_durable_before_ordered_execution() {
    let mut harness = Harness::created(4);
    let (_, inference_operation) = harness.start_to_inference("turn-tools");

    let assistant_pending = result(
        &mut harness.kernel,
        EffectResult::InferenceCompleted {
            operation_id: inference_operation,
            output: AssistantOutput {
                content: "I will look twice.".to_owned(),
                tool_calls: vec![call("call-a"), call("call-b")],
            },
        },
    );
    assert!(assistant_pending
        .effects
        .iter()
        .all(|effect| matches!(effect, Effect::Persist { .. })));

    let first_tool = commit(&mut harness.kernel, &mut harness.log, &assistant_pending);
    let first_operation = tool_operation(&first_tool);
    let forged_second = match &first_operation {
        OperationId::Tool {
            session_id,
            turn_id,
            step,
            ..
        } => OperationId::Tool {
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            step: *step,
            call_index: 1,
            call_id: ToolCallId::from("call-b"),
        },
        OperationId::Inference { .. } => unreachable!(),
    };
    let before = harness.kernel.clone();
    assert!(matches!(
        harness
            .kernel
            .transition(KernelInput::EffectResult(EffectResult::ToolCompleted {
                operation_id: forged_second,
                outcome: ToolOutcome::Succeeded {
                    output: "too early".to_owned(),
                },
            })),
        Err(KernelError::StaleOperation { .. })
    ));
    assert_eq!(
        harness.kernel, before,
        "invalid input must not mutate state"
    );

    let first_terminal = result(
        &mut harness.kernel,
        EffectResult::ToolCompleted {
            operation_id: first_operation.clone(),
            outcome: ToolOutcome::Failed {
                code: "not-found".to_owned(),
                message: "missing".to_owned(),
                retryable: false,
            },
        },
    );
    let second_tool = commit(&mut harness.kernel, &mut harness.log, &first_terminal);
    let second_operation = tool_operation(&second_tool);
    assert!(matches!(
        second_operation,
        OperationId::Tool { call_index: 1, .. }
    ));

    let second_terminal = result(
        &mut harness.kernel,
        EffectResult::ToolCompleted {
            operation_id: second_operation,
            outcome: ToolOutcome::Succeeded {
                output: "ok".to_owned(),
            },
        },
    );
    let next_inference_intent = commit(&mut harness.kernel, &mut harness.log, &second_terminal);
    assert!(matches!(
        persist_request(&next_inference_intent).event.kind,
        EventKind::InferenceStarted { step: 2, .. }
    ));

    assert!(matches!(
        harness.kernel.transcript(),
        [
            TranscriptMessage::User { .. },
            TranscriptMessage::Assistant { .. },
            TranscriptMessage::Tool { call_index: 0, .. },
            TranscriptMessage::Tool { call_index: 1, .. }
        ]
    ));

    let before_duplicate = harness.kernel.clone();
    assert!(harness
        .kernel
        .transition(KernelInput::EffectResult(EffectResult::ToolCompleted {
            operation_id: first_operation,
            outcome: ToolOutcome::Succeeded {
                output: "duplicate".to_owned(),
            },
        }))
        .is_err());
    assert_eq!(harness.kernel, before_duplicate);
}

#[test]
fn final_response_commits_assistant_then_exactly_one_terminal() {
    let mut harness = Harness::created(3);
    let (_, operation_id) = harness.start_to_inference("turn-final");
    let assistant = result(
        &mut harness.kernel,
        EffectResult::InferenceCompleted {
            operation_id,
            output: AssistantOutput {
                content: "finished".to_owned(),
                tool_calls: Vec::new(),
            },
        },
    );
    let terminal = commit(&mut harness.kernel, &mut harness.log, &assistant);
    assert!(matches!(
        persist_request(&terminal).event.kind,
        EventKind::TurnCompleted
    ));
    let finalized = commit(&mut harness.kernel, &mut harness.log, &terminal);
    assert!(matches!(
        finalized.effects.as_slice(),
        [Effect::TurnFinalized {
            terminal: TurnTerminal::Completed,
            ..
        }]
    ));
    assert_eq!(harness.kernel.active_turn_id(), None);
    assert!(matches!(
        harness.kernel.transcript(),
        [
            TranscriptMessage::User { .. },
            TranscriptMessage::Assistant { .. }
        ]
    ));
}

#[test]
fn step_cap_is_never_exceeded_for_a_range_of_limits() {
    for cap in 1..=5 {
        let mut harness = Harness::created(cap);
        let (_, mut inference) = harness.start_to_inference(&format!("turn-cap-{cap}"));

        for step in 1..=cap {
            let assistant = result(
                &mut harness.kernel,
                EffectResult::InferenceCompleted {
                    operation_id: inference.clone(),
                    output: AssistantOutput {
                        content: format!("step {step}"),
                        tool_calls: vec![call(&format!("call-{step}"))],
                    },
                },
            );
            let tool = commit(&mut harness.kernel, &mut harness.log, &assistant);
            let tool_terminal = result(
                &mut harness.kernel,
                EffectResult::ToolCompleted {
                    operation_id: tool_operation(&tool),
                    outcome: ToolOutcome::Succeeded {
                        output: "done".to_owned(),
                    },
                },
            );
            let next = commit(&mut harness.kernel, &mut harness.log, &tool_terminal);
            if step < cap {
                assert!(matches!(
                    persist_request(&next).event.kind,
                    EventKind::InferenceStarted { .. }
                ));
                let started = commit(&mut harness.kernel, &mut harness.log, &next);
                inference = inference_operation(&started);
            } else {
                let failure = persist_request(&next);
                assert!(matches!(
                    failure.event.kind,
                    EventKind::TurnFailed {
                        failure: TurnFailure {
                            code: FailureCode::StepLimitExceeded,
                            ..
                        },
                        ..
                    }
                ));
                let finalized = commit(&mut harness.kernel, &mut harness.log, &next);
                assert!(matches!(
                    finalized.effects.as_slice(),
                    [Effect::TurnFinalized {
                        terminal: TurnTerminal::Failed { .. },
                        ..
                    }]
                ));
            }
        }

        let started_count = harness
            .log
            .iter()
            .filter(|record| matches!(record.event.kind, EventKind::InferenceStarted { .. }))
            .count();
        assert_eq!(started_count, cap as usize);
        assert!(matches!(
            harness.kernel.transcript().last(),
            Some(TranscriptMessage::Assistant { .. })
        ));
    }
}

#[test]
fn cancellation_is_durable_and_late_inference_is_rejected() {
    let mut harness = Harness::created(3);
    let (turn_id, operation_id) = harness.start_to_inference("turn-cancel");
    let cancellation = command(
        &mut harness.kernel,
        Command::CancelTurn {
            turn_id,
            reason: "user stopped".to_owned(),
        },
    );
    assert!(cancellation.effects.iter().any(|effect| matches!(
        effect,
        Effect::CancelOperation { operation_id: cancelled } if cancelled == &operation_id
    )));
    let terminal = commit(&mut harness.kernel, &mut harness.log, &cancellation);
    assert!(matches!(
        persist_request(&terminal).event.kind,
        EventKind::TurnCancelled { .. }
    ));
    let finalized = commit(&mut harness.kernel, &mut harness.log, &terminal);
    assert!(matches!(
        finalized.effects.as_slice(),
        [Effect::TurnFinalized {
            terminal: TurnTerminal::Cancelled { .. },
            ..
        }]
    ));

    let before = harness.kernel.clone();
    assert!(matches!(
        harness.kernel.transition(KernelInput::EffectResult(
            EffectResult::InferenceCompleted {
                operation_id,
                output: AssistantOutput {
                    content: "late".to_owned(),
                    tool_calls: Vec::new(),
                },
            }
        )),
        Err(KernelError::StaleOperation { .. })
    ));
    assert_eq!(harness.kernel, before);
    assert!(matches!(
        harness.kernel.transcript(),
        [
            TranscriptMessage::User { .. },
            TranscriptMessage::Assistant { .. }
        ]
    ));
}

#[test]
fn cancellation_closes_every_requested_tool_without_executing_the_rest() {
    let mut harness = Harness::created(3);
    let (turn_id, inference) = harness.start_to_inference("turn-cancel-tools");
    let assistant = result(
        &mut harness.kernel,
        EffectResult::InferenceCompleted {
            operation_id: inference,
            output: AssistantOutput {
                content: String::new(),
                tool_calls: vec![call("cancel-a"), call("cancel-b")],
            },
        },
    );
    let first_tool = commit(&mut harness.kernel, &mut harness.log, &assistant);
    let first_operation = tool_operation(&first_tool);

    let cancellation = command(
        &mut harness.kernel,
        Command::CancelTurn {
            turn_id,
            reason: "stop tools".to_owned(),
        },
    );
    assert!(cancellation.effects.iter().any(|effect| matches!(
        effect,
        Effect::CancelOperation { operation_id } if operation_id == &first_operation
    )));
    let first_cancelled = commit(&mut harness.kernel, &mut harness.log, &cancellation);
    assert!(matches!(
        persist_request(&first_cancelled).event.kind,
        EventKind::ToolTerminalRecorded {
            call_index: 0,
            outcome: ToolOutcome::Cancelled { .. },
            ..
        }
    ));
    let second_cancelled = commit(&mut harness.kernel, &mut harness.log, &first_cancelled);
    assert!(matches!(
        persist_request(&second_cancelled).event.kind,
        EventKind::ToolTerminalRecorded {
            call_index: 1,
            outcome: ToolOutcome::Cancelled { .. },
            ..
        }
    ));
    let terminal = commit(&mut harness.kernel, &mut harness.log, &second_cancelled);
    assert!(matches!(
        persist_request(&terminal).event.kind,
        EventKind::TurnCancelled { .. }
    ));
    let finalized = commit(&mut harness.kernel, &mut harness.log, &terminal);
    assert!(matches!(
        finalized.effects.as_slice(),
        [Effect::TurnFinalized { .. }]
    ));

    let tool_terminals = harness
        .log
        .iter()
        .filter(|record| matches!(record.event.kind, EventKind::ToolTerminalRecorded { .. }))
        .count();
    assert_eq!(tool_terminals, 2);
}

#[test]
fn replay_reissues_stable_recovery_operations_and_matches_live_projection() {
    let mut harness = Harness::created(4);
    let (_, inference) = harness.start_to_inference("turn-replay");
    let assistant = result(
        &mut harness.kernel,
        EffectResult::InferenceCompleted {
            operation_id: inference.clone(),
            output: AssistantOutput {
                content: "checking".to_owned(),
                tool_calls: vec![call("recover-me")],
            },
        },
    );
    let tool = commit(&mut harness.kernel, &mut harness.log, &assistant);
    let live_tool_operation = tool_operation(&tool);

    let mut after_inference_started = Kernel::replay(&harness.log[..3]).expect("valid prefix");
    let resumed = after_inference_started
        .recover()
        .expect("recover inference");
    assert_eq!(inference_operation(&resumed), inference);
    assert!(matches!(
        resumed.effects.as_slice(),
        [Effect::ResumeInference { .. }]
    ));

    let mut after_tool_intent = Kernel::replay(&harness.log).expect("valid tool-intent prefix");
    let recovered = after_tool_intent.recover().expect("recover tool");
    assert_eq!(tool_operation(&recovered), live_tool_operation);
    assert!(matches!(
        recovered.effects.as_slice(),
        [Effect::RecoverTool { .. }]
    ));

    let tool_terminal = result(
        &mut harness.kernel,
        EffectResult::ToolCompleted {
            operation_id: live_tool_operation,
            outcome: ToolOutcome::Succeeded {
                output: "value".to_owned(),
            },
        },
    );
    let inference_intent = commit(&mut harness.kernel, &mut harness.log, &tool_terminal);
    let inference_again = commit(&mut harness.kernel, &mut harness.log, &inference_intent);
    let final_assistant = result(
        &mut harness.kernel,
        EffectResult::InferenceCompleted {
            operation_id: inference_operation(&inference_again),
            output: AssistantOutput {
                content: "done".to_owned(),
                tool_calls: Vec::new(),
            },
        },
    );
    let terminal = commit(&mut harness.kernel, &mut harness.log, &final_assistant);
    let _finalized = commit(&mut harness.kernel, &mut harness.log, &terminal);

    let serialized = serde_json::to_vec(&harness.log).expect("serialize log");
    let decoded: Vec<EventRecord> = serde_json::from_slice(&serialized).expect("decode log");
    let replayed = Kernel::replay_expected(&manifest(4), &decoded).expect("replay full log");
    assert_eq!(replayed.transcript(), harness.kernel.transcript());
    assert_eq!(replayed.last_terminal(), harness.kernel.last_terminal());
}

#[test]
fn persistence_mismatch_unlocks_no_side_effect_and_retry_is_identical() {
    let mut harness = Harness::created(2);
    let requested = command(
        &mut harness.kernel,
        Command::StartTurn {
            turn_id: TurnId::from("turn-persist"),
            content: "hello".to_owned(),
        },
    );
    let request = persist_request(&requested);
    let before = harness.kernel.clone();
    let wrong = EventRecord {
        sequence: request.expected_next_sequence + 1,
        event: request.event.clone(),
    };
    assert!(matches!(
        harness
            .kernel
            .transition(KernelInput::EffectResult(EffectResult::Persisted {
                record: Box::new(wrong)
            })),
        Err(KernelError::SequenceMismatch { .. })
    ));
    assert_eq!(harness.kernel, before);

    let retry = result(
        &mut harness.kernel,
        EffectResult::PersistenceFailed {
            event_id: request.event.event_id.clone(),
            retryable: true,
            message: "transient".to_owned(),
        },
    );
    assert_eq!(persist_request(&retry), request);
}

#[test]
fn manifest_is_exactly_pinned_and_invalid_limits_are_rejected() {
    let mut invalid = manifest(0);
    assert!(matches!(
        validate_manifest(&invalid),
        Err(KernelError::InvalidManifest { .. })
    ));

    invalid = manifest(2);
    invalid.tools.push(invalid.tools[0].clone());
    assert!(matches!(
        validate_manifest(&invalid),
        Err(KernelError::InvalidManifest { .. })
    ));

    let harness = Harness::created(2);
    let mut changed = manifest(2);
    changed.system_prompt.push_str(" changed");
    assert!(matches!(
        Kernel::replay_expected(&changed, &harness.log),
        Err(KernelError::ReplayViolation { .. })
    ));
}

#[test]
fn event_schema_has_a_stable_golden_shape_and_rejects_reordered_tools() {
    let mut harness = Harness::created(3);
    let (_, inference) = harness.start_to_inference("turn-golden");
    let assistant = result(
        &mut harness.kernel,
        EffectResult::InferenceCompleted {
            operation_id: inference,
            output: AssistantOutput {
                content: String::new(),
                tool_calls: vec![call("gold-a"), call("gold-b")],
            },
        },
    );
    let first_tool = commit(&mut harness.kernel, &mut harness.log, &assistant);
    let first_terminal = result(
        &mut harness.kernel,
        EffectResult::ToolCompleted {
            operation_id: tool_operation(&first_tool),
            outcome: ToolOutcome::Succeeded {
                output: "a".to_owned(),
            },
        },
    );
    let second_tool = commit(&mut harness.kernel, &mut harness.log, &first_terminal);
    let second_terminal = result(
        &mut harness.kernel,
        EffectResult::ToolCompleted {
            operation_id: tool_operation(&second_tool),
            outcome: ToolOutcome::Succeeded {
                output: "b".to_owned(),
            },
        },
    );
    let _next = commit(&mut harness.kernel, &mut harness.log, &second_terminal);

    let created = serde_json::to_value(&harness.log[0]).expect("serialize event");
    assert_eq!(created["sequence"], 0);
    assert_eq!(created["event"]["v"], SCHEMA_VERSION);
    assert_eq!(created["event"]["eventId"], "session/9:session-1/created");
    assert_eq!(created["event"]["kind"]["type"], "session.created");

    let terminal_positions: Vec<usize> = harness
        .log
        .iter()
        .enumerate()
        .filter_map(|(index, record)| {
            matches!(record.event.kind, EventKind::ToolTerminalRecorded { .. }).then_some(index)
        })
        .collect();
    assert_eq!(terminal_positions.len(), 2);
    let mut reordered = harness.log.clone();
    let first_event = reordered[terminal_positions[0]].event.clone();
    reordered[terminal_positions[0]].event = reordered[terminal_positions[1]].event.clone();
    reordered[terminal_positions[1]].event = first_event;
    assert!(Kernel::replay(&reordered).is_err());
}

#[test]
fn provider_failure_finalizes_with_an_assistant_role_boundary() {
    let mut harness = Harness::created(2);
    let (_, inference) = harness.start_to_inference("turn-provider-fail");
    let failure = result(
        &mut harness.kernel,
        EffectResult::InferenceFailed {
            operation_id: inference,
            failure: TurnFailure {
                code: FailureCode::Provider,
                message: "authenticated stream ended early".to_owned(),
                retryable: true,
            },
        },
    );
    assert!(matches!(
        persist_request(&failure).event.kind,
        EventKind::TurnFailed { .. }
    ));
    let finalized = commit(&mut harness.kernel, &mut harness.log, &failure);
    assert!(matches!(
        finalized.effects.as_slice(),
        [Effect::TurnFinalized {
            terminal: TurnTerminal::Failed { .. },
            ..
        }]
    ));
    assert!(matches!(
        harness.kernel.transcript(),
        [
            TranscriptMessage::User { .. },
            TranscriptMessage::Assistant { .. }
        ]
    ));
}
