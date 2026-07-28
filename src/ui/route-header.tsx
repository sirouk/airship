import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { Popover } from "./popover";

/**
 * USAGE — the one route header. Ten routes, two densities, nothing else.
 *
 * A *tool* route (Editor, Terminal, Memory, Workspace) starts its content at
 * the top of the frame:
 *
 *   <RouteHeader
 *     routeId="editor"
 *     density="tool"
 *     title="Editor"
 *     eyebrow="Device-executed · page workspace"
 *     description="Files, version-fenced editing, and browser-native source control share one workspace."
 *     status={<Seal state="none" density="chip" label="Ephemeral · this page only" />}
 *     actions={<button class="small-button" type="button" onClick={…}>New terminal</button>}
 *   />
 *
 * A *document* route (Proof, Vault, Account, Sessions) keeps its sentence on
 * screen — pass nothing, because `density` defaults to `"document"`:
 *
 *   <RouteHeader routeId="proof" title="Proof"
 *     eyebrow="Inspectable, portable evidence"
 *     description="Endpoint attestation and conversation receipts are different claims. Airship never presents one as the other."
 *   />
 *
 * Rules a caller must know:
 * - `eyebrow` and `description` are passed **verbatim**, in the sentence case
 *   they are authored in; the uppercase is CSS. Never re-word them to fit.
 * - Both strings always render. At `tool` density they are the ⓘ panel's
 *   heading and body; at `document` density they are visible in the header and
 *   the ⓘ appears only if you pass `notes`. Neither density has a state where
 *   a route's own sentence is not reachable.
 * - `title` is always a real `<h1>`. `titleVisible={false}` clips it to the
 *   accessible tree — use it only where the route's own <Tabs> strip renders
 *   the same word as the selected tab, so the word is still on screen once.
 * - `notes` is for facts a route states nowhere else (Terminal's thread id,
 *   its process-lifetime caveats). They render inside the ⓘ, and their
 *   presence is announced by the ⓘ's accessible name.
 * - `status` takes <Seal density="chip"> chips; `actions` takes buttons.
 */

/**
 * Where the route's descriptive sentence lives.
 *
 * `tool` is the 44px bar: content begins immediately below it and the sentence
 * moves one rung down the ladder, into the ⓘ. `document` keeps the sentence
 * visible under the title, for routes whose whole job is to be read.
 *
 * The default is `document` on purpose — the density that hides the least. A
 * caller who has not thought about it must not silently move a sentence behind
 * a disclosure.
 */
export type RouteHeaderDensity = "tool" | "document";

/**
 * The page-memory ledger of routes whose ⓘ has already been shown.
 *
 * Module scope, never storage: "remembered-dismissed per route in page memory"
 * means exactly this page's memory, so a reload legitimately shows a first-run
 * caveat again rather than assuming a reader who may not be the same person.
 */


/**
 * Whether a route renders the ⓘ at all.
 *
 * Only when the panel holds something the resting header does not already
 * show. A disclosure that merely restates a visible line is noise, and noise
 * is how the one first-run caveat that matters gets dismissed unread — so at
 * `document` density, where the eyebrow and the sentence are both on screen,
 * there is no ⓘ unless the route has notes of its own.
 */
export function routeAboutAutoOpens(input: Readonly<{
  carriesDescription: boolean;
  carriesNotes: boolean;
}>): boolean {
  return input.carriesDescription || input.carriesNotes;
}

/**
 * The ⓘ's accessible name, which states what is inside it.
 *
 * A disclosure that does not say what it contains is a place to bury things.
 * The eyebrow is quoted verbatim because it is short and is the most specific
 * thing the panel holds; the other contents are named by what they are.
 */
export function routeAboutLabel(input: Readonly<{
  title: string;
  eyebrow: string;
  carriesDescription: boolean;
  carriesNotes: boolean;
}>): string {
  const carried: string[] = [];
  if (input.carriesDescription) carried.push("what this view does");
  if (input.carriesNotes) carried.push("this route's caveats");
  if (carried.length === 0) return `About ${input.title}. ${input.eyebrow}.`;
  const clause = carried.length === 1
    ? `and ${carried[0]}`
    : `${carried.slice(0, -1).join(", ")}, and ${carried[carried.length - 1]}`;
  return `About ${input.title}. ${input.eyebrow}, ${clause}.`;
}

export type RouteHeaderProps = Readonly<{
  /** Stable per-route key — the route hash without its `#`. Keys the ⓘ memory. */
  routeId: string;
  title: string;
  /** The route's monospace eyebrow, verbatim. Becomes the ⓘ panel's heading. */
  eyebrow: string;
  /** The route's descriptive sentence, verbatim. */
  description: string;
  density?: RouteHeaderDensity;
  /** Clip the heading to the accessible tree; only where a tab already says it. */
  titleVisible?: boolean;
  /** Route-level status, as `<Seal density="chip">` chips. */
  status?: ComponentChildren;
  /** Route-level actions, as buttons. */
  actions?: ComponentChildren;
  /** Extra verbatim route facts for the ⓘ panel, below the description. */
  notes?: ComponentChildren;
  headingId?: string;
  class?: string;
}>;

/**
 * A 44px row that carries a route's name, its meaning, its state and its verbs.
 *
 * It exists because ten routes had each grown the same 194–213px slab — mono
 * eyebrow, 47px serif H1, paragraph, durability pill — which is 23–25% of the
 * viewport spent restating the selected nav item. Nothing in that slab is
 * deleted here: the title stays a permanent heading, the eyebrow becomes the
 * ⓘ panel's heading (same words, same mono uppercase, one rung down), the
 * sentence is either visible or the ⓘ's body, and the four different
 * route-status treatments become one right-hand slot.
 */
export function RouteHeader({
  routeId,
  title,
  eyebrow,
  description,
  density = "document",
  titleVisible = true,
  status,
  actions,
  notes,
  headingId,
  class: className,
}: RouteHeaderProps) {
  const hostRef = useRef<HTMLElement>(null);
  const carriesDescription = density === "tool";
  const carriesNotes = notes !== undefined && notes !== null && notes !== false;
  const aboutRendered = routeAboutAutoOpens({ carriesDescription, carriesNotes });


  return (
    <header
      class={["route-header", className].filter(Boolean).join(" ")}
      data-density={density}
      ref={hostRef}
    >
      <div class="route-header__bar">
        {/* The eyebrow keeps its exact words and its exact mono uppercase in
            both densities. What changes is the rung: visible here, or the ⓘ
            panel's heading there. It never renders in both places at once. */}
        {carriesDescription ? null : (
          <p class="route-header__eyebrow eyebrow" id={`route-${routeId}-eyebrow`}>{eyebrow}</p>
        )}
        <h1 class={titleVisible ? "route-title" : "sr-only"} id={headingId}>{title}</h1>
        {aboutRendered ? (
          <Popover
            class="route-header__about"
            triggerClass="route-header__about-trigger"
            label={routeAboutLabel({ title, eyebrow, carriesDescription, carriesNotes })}
            heading={eyebrow}
            trigger={<span aria-hidden="true">ⓘ</span>}
          >
            {carriesDescription ? <p class="route-header__about-description">{description}</p> : null}
            {notes}
          </Popover>
        ) : null}
        {status ? <div class="route-header__status">{status}</div> : null}
        {actions ? <div class="route-header__actions">{actions}</div> : null}
      </div>
      {carriesDescription ? null : (
        <p class="route-header__description" id={`route-${routeId}-description`}>{description}</p>
      )}
    </header>
  );
}
