import { useEffect, useRef, useState } from "preact/hooks";
import type { ApprovalBroker, ApprovalBrokerSnapshot, PendingApproval } from "../approvals/broker";
import { Icon } from "./icons";
import { remainingApprovalTime, writeApprovalFacts } from "./approval-presentation";
import { trapFocus } from "./focus-trap";

export function ApprovalDock({ broker }: { broker: ApprovalBroker }) {
  const [snapshot, setSnapshot] = useState<ApprovalBrokerSnapshot>(() => broker.snapshot());
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement>();
  const current = snapshot.pending[0];
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => broker.subscribe(setSnapshot), [broker]);

  useEffect(() => {
    if (!current) return;
    // The request arrives unprompted mid-turn, so the control the user was on
    // has to be given back when the decision resolves; without this the shell
    // inerting the background would strand focus on <body>.
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    panel.current?.querySelector<HTMLButtonElement>(".approval-deny")?.focus();
    return () => restore.current?.focus({ preventScroll: true });
  }, [current?.id]);

  useEffect(() => {
    if (!current) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [current?.id]);

  if (!current) return null;

  const writeFacts = current.effect === "write" ? writeApprovalFacts(current.displayArguments) : undefined;
  return (
    <div
      class="approval-scrim"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          broker.decide(current.id, "deny");
        } else if (event.key === "Tab") {
          trapFocus(event, panel.current);
        }
      }}
    >
      <div
        ref={panel}
        class={`approval-dock risk-${current.risk}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-description"
        tabIndex={-1}
      >
        <header class="approval-heading">
          <span class="approval-glyph"><Icon name={iconForApproval(current)} /></span>
          <div>
            <span class="eyebrow">Capability request · {current.risk}</span>
            <h2 id="approval-title">Allow {current.toolName} once?</h2>
          </div>
          {snapshot.pending.length > 1 ? <span class="approval-queue">1 of {snapshot.pending.length}</span> : null}
        </header>

        <p class="approval-expiry" role="timer">Decision expires in <strong>{remainingApprovalTime(current.expiresAt, clock)}</strong></p>

        <p id="approval-description" class="approval-description">{current.description}</p>

        <div class="approval-facts" aria-label="Approval identity">
          <span><small>Effect</small><strong>{current.effect}</strong></span>
          <span title={current.operationId}><small>Operation</small><strong>{compactId(current.operationId)}</strong></span>
          <span title={current.turnId}><small>Turn</small><strong>{compactId(current.turnId)}</strong></span>
          <span><small>Requested</small><strong>{formatApprovalTime(current.requestedAt)}</strong></span>
        </div>

        {writeFacts ? <section class="approval-write-facts" aria-label="Write consequence">
          <div><small>Target path</small><strong>{writeFacts.target ?? "Adapter-selected target"}</strong></div>
          <div><small>Change</small><strong class="approval-disposition">{writeFacts.disposition}</strong></div>
          <div><small>New size</small><strong>{writeFacts.byteLength === undefined ? "Not supplied" : `${writeFacts.byteLength} bytes`}</strong></div>
          <div><small>Size delta</small><strong>{writeFacts.byteDelta === undefined ? "Not supplied" : `${writeFacts.byteDelta >= 0 ? "+" : ""}${writeFacts.byteDelta} bytes`}</strong></div>
          {writeFacts.before !== undefined || writeFacts.after !== undefined ? <div class="approval-diff"><small>Bounded old → new preview</small><pre><del>{writeFacts.before || "∅"}</del>{"\n"}<ins>{writeFacts.after || "∅"}</ins></pre></div> : null}
        </section> : null}

        <details class="approval-arguments">
          <summary>Arguments shown to the approval policy</summary>
          <pre>{JSON.stringify(current.displayArguments, null, 2)}</pre>
        </details>

        <p class="approval-assurance"><Icon name="lock" size={15} /> Secret-like fields are redacted and the display copy is bounded. Approval applies only to this operation ID.</p>

        <footer class="approval-actions">
          <button class="small-button approval-deny" type="button" onClick={() => broker.decide(current.id, "deny")}>Deny</button>
          <button class="small-button approval-allow" type="button" onClick={() => broker.decide(current.id, "allow")}>Allow once</button>
        </footer>
      </div>
    </div>
  );
}

function iconForApproval(request: PendingApproval): "workspace" | "cloud" | "terminal" | "access" | "warning" {
  if (request.effect === "write") return "workspace";
  if (request.effect === "network") return "cloud";
  if (request.effect === "execute") return "terminal";
  if (request.effect === "identity") return "access";
  return "warning";
}

function compactId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`;
}

function formatApprovalTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
