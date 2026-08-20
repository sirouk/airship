# Inference provider registry

Status: current provider-neutral connection contract.

Airship keeps provider credentials in page memory and exposes one generic
**Providers** surface. No provider gets a privileged transport or trust lane.

## Built-in provider entries

| Provider | Protocol | Default endpoint | Boundary |
| --- | --- | --- | --- |
| OpenAI | `openai-responses` | `https://api.openai.com/v1` | `provider-tls` |
| Anthropic | `anthropic-messages` | `https://api.anthropic.com/v1` | `provider-tls` |
| xAI | `openai-responses` | `https://api.x.ai/v1` | `provider-tls` |
| Chutes | `openai-compatible` | `https://llm.chutes.ai/v1` | `provider-tls` |
| Ollama | `openai-compatible` | `http://127.0.0.1:11434` | `loopback-local` |
| LM Studio | `openai-compatible` | `http://127.0.0.1:1234` | `loopback-local` |
| Custom | `openai-compatible` | user supplied | `provider-tls` |

## Connection rules

- Cloud providers use direct browser API calls with user-supplied credentials.
- Local providers are explicit loopback connections.
- Credentials stay in page memory. They are not written to session storage,
  durable vaults, logs, or URLs.
- Provider catalogs contribute provider metadata only. Models are runtime data
  discovered from each connected provider's own listing.

## Session contract

Airship records enough data to explain every turn later:

- provider ID;
- connection ID and generation;
- model ID;
- transport boundary.

A session's model can change without forking history. The change is appended as
a session event and affects the next turn only. Prior turns keep their original
provider/model provenance.

## Boundaries and claims

- `provider-tls` means the turn went to a remote provider over TLS.
- `loopback-local` means the turn stayed on the current machine.
- Airship does not elevate any provider to a stronger trust tier through copy or
  UI labels.

## Optional extension role

Most providers work browser-direct. When a browser or host policy blocks a
reviewed request shape, the optional extension may help with reachability. That
changes transport reachability, not provider authorization or trust meaning.
