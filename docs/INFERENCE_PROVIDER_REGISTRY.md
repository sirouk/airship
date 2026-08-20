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

- The stock static build connects cloud providers with browser-direct API keys. It does not acquire provider OAuth grants or advertise provider account sign-in.
- The generic registry can validate an already-issued, page-memory OAuth token for a host-composed or extension-relayed integration, but no official static provider entry configures that path.
- Local providers are explicit loopback connections.
- Credentials stay in page memory. They are not written to session storage,
  durable vaults, logs, or URLs.
- Provider catalogs contribute provider metadata only. Models are runtime data
  discovered from each connected provider's own listing.

## User-owned OpenAI-compatible endpoints

The Providers screen can create an immutable page-lifetime descriptor from a
name, HTTPS API base URL, optional model-catalog URL, and API-key header format.
The key is held separately in the private connection registry. A failed catalog
read publishes neither a connection nor a provider descriptor. Model selection
is local; the first user turn checks inference access.

The static CSP permits dynamic HTTPS connections for this purpose while keeping
plaintext remote origins, wildcard hosts, and broad WebSocket schemes blocked.
The provider remains responsible for browser CORS support.

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
