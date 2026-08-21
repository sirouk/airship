# Prime runtime — follow-up milestones

Status: the stock Prime runtime is integrated. Session authority, deterministic
conversation titles, runtime selection, context compaction, fork admission,
JavaScript kernel execution, tools, and subagents are production paths. This
file lists optional follow-up work; it is not a claim that the shipped runtime
is still "in flight."

## Host-scheduled goals and heartbeats

The journal and tool vocabulary can record goal and heartbeat state. A future
page-lifetime scheduler may emit due ticks while the page is open. It must use a
host-owned timer, persist no credential, and never imply background execution
after the browser suspends or closes the page.

## Skill authoring

Registered `SKILL.md` entries and prompt blocks are supported. A future
skill-creator surface may add guided authoring and validation. It must write
through the same bounded profile/workspace authorities as other edits; it does
not receive an ambient filesystem or shell.

## Optional MCP transport

A reviewed Streamable HTTP adapter may be added for user-configured MCP
servers. It must use explicit destinations, page-memory credentials, bounded
payloads, aborts, and the existing approval policy. No socket or localhost
privilege is implied by the static build.

## Optional Python kernel selection

The separately tested Pyodide engine remains an environment-qualified module.
Making it a stock session choice requires a visible engine selector, durable
binding, equivalent protocol authentication, and browser/live-pack gates. The
stock Prime session therefore continues to report JavaScript honestly.

## Provider authorization boundary

Provider account authorization is not a hidden Prime milestone. The stock
static build exposes browser-direct API-key setup. The optional extension may
relay a reviewed request that already has authority, but it does not acquire an
OAuth grant or create a provider sign-in flow.

## Explicitly deferred

- kernel namespace snapshot/restore;
- unattended execution after browser suspension or close;
- provider-specific privileged runtimes;
- HTML export, unless a bounded local export contract is defined.
