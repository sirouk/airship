# Airship DCAP QVL WASM

Deferred, browser-only Intel SGX/TDX quote verification. This adapter wraps
`dcap-qvl`'s pure-Rust verifier and collateral client. It is deliberately kept
out of Airship's startup bundle and loaded only when Chutes endpoint evidence
must be evaluated.

The browser build uses dcap-qvl's `rustcrypto` backend. The native `ring`
backend emits unresolved assembly imports on `wasm32` and must not be enabled.

Unlike the compact WebCrypto diagnostics, a successful QVL result includes
certificate revocation, QE Identity, collateral freshness, quote signature,
TCB, and Intel trust-chain evaluation. Airship still separately verifies the
fresh nonce + endpoint-key binding and the Chutes runtime measurement policy.
