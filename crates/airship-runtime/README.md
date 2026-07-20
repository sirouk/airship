# airship-runtime

`airship-runtime` is Airship's deterministic, side-effect-free agent kernel.
It owns the versioned session and turn grammar, but it does not perform I/O.
Callers persist emitted events and execute emitted inference or tool effects,
then feed acknowledgements and outcomes back into the kernel.

The crate deliberately has no browser, network, filesystem, clock, random,
database, cryptography, or provider SDK dependency. Stable identifiers are
derived from caller-supplied session/turn/tool-call identifiers. Log sequence
numbers and cryptographic envelopes remain the responsibility of the session
store.

The initial implementation executes tool calls one at a time. This keeps
external execution and durable result order identical. A future host may add
parallel execution by buffering results while preserving the same event
grammar and operation identifiers.
