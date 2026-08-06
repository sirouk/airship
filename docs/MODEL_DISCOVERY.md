# Chutes model discovery contract

Airship reads Chutes directly from the browser. It does not need an Airship
catalog service, and it never treats a model name suffix as a security signal.
The Chutes frontend's `/api/models` and `/api/chat/models` routes are not used:
they are server-side BFFs with environment keys, curation, rate limits, and
fallback records rather than provider-authoritative browser contracts.

## Browser-callable sources

`GET https://llm.chutes.ai/v1/models` is the inference source of truth and is
currently public. Its envelope is:

```json
{ "object": "list", "data": ["model records"] }
```

Each record is the model server's `/v1/models` record plus fields injected by
`chutes-api`: `id`, `chute_id`, `confidential_compute`, `price`, and `pricing`.
Observed capability fields include `root`, `owned_by`, `quantization`,
`context_length`, `max_model_len`, `max_output_length`, `input_modalities`,
`output_modalities`, `supported_features`, and
`supported_sampling_parameters`. Fields are optional because older or partially
refreshed records exist. `price.{input,output,input_cache_read}.{usd,tao}` and
`pricing.{prompt,completion,input_cache_read}` are Chutes' per-million-token
rates. Despite the OpenRouter-like property names, this repository does not
divide them by one million.

`GET https://api.chutes.ai/chutes/?include_public=true&template=vllm&page=0&limit=500&include_schemas=false`
is optional management enrichment. Its envelope is:

```json
{
  "total": 1,
  "page": 0,
  "limit": 500,
  "items": ["ChuteResponse records"],
  "cord_refs": {}
}
```

Relevant `ChuteResponse` fields are `chute_id`, `name`, `slug`, `tagline`,
`public`, `standard_template`, `tee`, `hot`, `invocation_count`, `instances`,
and `current_estimated_price`. `hot` is computed when the response is built as
“at least one active and verified instance”; it is useful live state, not a
durability or latency promise. `current_estimated_price.per_million_tokens`
contains input, output, and cache-read USD/TAO rates; the same object also has
GPU-hour/second economics. `GET /chutes/{id}` returns the same `ChuteResponse`
shape for one chute.

## Embedding chutes

Embedding deployments are absent from `llm.chutes.ai/v1/models`, which lists the
chat router's models only, so they are discovered from the management API
instead: `GET /chutes/?include_public=true&template=embedding&…` filters
server-side and every returned record carries `standard_template: "embedding"`.
Airship filters again on the client and admits only `tee: true`, because
`confidential-remote` is a claim about attested compute and `/e2e/invoke` needs
an instance public key to seal against.

The path *inside* the chute comes from the same response. `cord_refs` maps each
chute's `cord_ref_id` to its cord list, and an embedding chute publishes a
non-streaming `POST` cord whose `public_api_path` is `/v1/embeddings` (its
internal `path` is the chute author's own, e.g. `/embed`). That public path is
what `X-E2E-Path` carries; the chute's `name` is what the request body's `model`
field carries. Neither is written down in this repository.

Vector width is not a property of embeddings and is not declared: Airship takes
one probe vector from the chosen deployment and counts it, then refuses any
later vector of another width rather than reshaping it. At the time of writing
one or more public embedding chutes may exist; no model id or vector width is
assumed by this repository.

Embedding requests use the same encrypted transport as chat: the batch is sealed
to the serving instance's E2EE public key and posted to `POST /e2e/invoke` with
`X-E2E-Stream: false`, because an embeddings response is one frame rather than a
stream. No per-chute hostname is ever contacted, which is why none appears in
`connect-src`.

TEE evidence for a public chute is requested anonymously with
`GET /chutes/{id}/evidence?nonce=<64 lowercase-or-uppercase hex characters>`.
The response is:

```json
{
  "evidence": [
    {
      "quote": "base64 TDX quote",
      "gpu_evidence": ["structured per-GPU evidence"],
      "instance_id": "instance ID",
      "certificate": "base64 DER certificate"
    }
  ],
  "failed_instance_ids": []
}
```

For actual encrypted execution, authenticated `GET /e2e/instances/{chute_id}`
returns `{instances:[{instance_id,e2e_pubkey,nonces[]}], nonce_expires_in,
nonce_expires_at}`. Authenticated `POST /e2e/invoke` consumes one nonce and the
`X-Chute-Id`, `X-Instance-Id`, `X-E2E-Nonce`, `X-E2E-Stream`, and `X-E2E-Path`
headers. These two routes are explicitly classified as `chutes:invoke` by the
OAuth middleware.

## Authority and honesty boundaries

- `/v1/models` is authoritative for a shared-gateway model ID, advertised
  modalities/features, token limits, token price, `chute_id`, and the
  `confidential_compute` deployment claim.
- `/chutes` is authoritative for management metadata at response time,
  especially `hot` and the chute's `tee` configuration.
- `provider` in Airship is inferred from the portion of `id` before `/`.
  `owned_by` describes the serving engine (for example vLLM or SGLang), not the
  model publisher.
- Missing capability data means unknown. A required feature, token limit,
  price, or trust property therefore fails closed.
- `confidential_compute: true` and `tee: true` make a model a candidate for E2EE
  discovery and attestation. They do not prove the selected instance, model
  artifact, request, response, or transcript. Airship leaves verification at
  `unverified` until the separate evidence and verifier pipeline succeeds.
- `/v1/models` does not expose TTFT, TPS, capacity, or a live health bit. Airship
  never infers those from catalog order or a `-TEE` suffix.

## API key and OAuth behavior

- Anonymous `GET /v1/models` works. Airship omits authorization by default.
  An optional in-memory bearer can avoid anonymous rate buckets. A `cpk_` key
  needs chute invocation access; a `cak_` OAuth token needs `chutes:invoke`.
- A Chutes app registered with `public: true` uses Authorization Code + S256
  PKCE with no client secret at the token endpoint. Airship performs that
  exchange directly, keeps tokens in page memory, and fails closed if a legacy
  confidential registration rejects secretless exchange.
- Public `/chutes` reads and public chute evidence also work anonymously, so
  Airship deliberately omits credentials for those requests. This both reduces
  credential exposure and avoids current generic-resource OAuth path-mapping
  edge cases in `chutes-api`.
- Private chute management is intended to use `chutes:read`; encrypted instance
  discovery and invocation use `chutes:invoke`. They are different privileges.
- Credentials are supplied through a callback, sent only in an Authorization
  header to `/v1/models` when explicitly configured, and never included in a
  URL, issue, normalized record, persistent store, or cache key.

The client keeps only normalized public metadata in memory: five minutes fresh,
up to thirty minutes stale-on-error by default. Requests are bounded, concurrent
loads are deduplicated, aborts are per caller, and management failure does not
discard usable inference metadata.
