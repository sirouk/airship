# Model metadata contract

Airship joins three browser-callable Chutes authorities by `chute_id`:

- `llm.chutes.ai/v1/models` is authoritative for invocable IDs, declared modalities, features, sampling parameters, token limits, price, and the confidential-compute catalog claim.
- `api.chutes.ai/chutes/` supplies optional management metadata such as hot/cold state, deployment TEE claim, invocation count, and fallback price.
- `api.chutes.ai/chutes/utilization` supplies timestamped operational telemetry. Ratios, request counts, and instance capacity are advisory and can be stale or race the next request.

The normalized model keeps provenance for capabilities, runtime owner, provider-namespace inference, availability, popularity, utilization, pricing, and derived namespaced tags. `snapshot.fetchedAt`, per-source state, `telemetry.observedAt`, and its bounded freshness classification expose both retrieval and observation freshness. The source-declared `owned_by` values currently describe serving runtimes (for example, vLLM or SGLang), so they are not mislabeled as model publishers. Missing fields remain missing; filtering fails closed when a requested field is unavailable.

Catalog claims and telemetry never become proof. Only the attestation gate may promote a live invocation after nonce-bound cryptographic evidence and runtime policy verification. Sorting is stable and provider-neutral; popularity uses fresh one-hour, fifteen-minute, or five-minute request telemetry before falling back to the management lifetime count, utilization means least-loaded-first, missing values sort last, and no model ID receives special treatment.
