import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Contracts the entry component can only be held to by reading it.
 *
 * `app.tsx` is the one module in this tree that cannot be mounted in a unit
 * test: it is the whole cockpit, it owns the runtime, and every branch worth
 * pinning here lives inside a 14k-line component. The behaviour each of these
 * defects produced was nonetheless exact — a composer ceiling that could only
 * shrink, a footer that named the one cause that had not happened, a return
 * control that never moved the screen — so the rule each fix installed is
 * pinned by reading the source the way the other cross-file contracts in this
 * directory do, naming the failure rather than the syntax.
 */
const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

/** The source of one top-level or nested function, from its signature to its closing brace. */
function functionBody(declaration: string): string {
  const signature = declaration.trimStart();
  const start = app.indexOf(signature);
  expect(start, `${signature} exists`).toBeGreaterThan(-1);
  // The closing brace is the one at the signature's own indentation — a nested
  // function's body ends long before the component's does, and slicing to the
  // wrong brace would let a `not.toContain` assertion pass on a body it never
  // read.
  const indent = app.slice(app.lastIndexOf("\n", start) + 1, start);
  const end = app.indexOf(`\n${indent}}\n`, start);
  expect(end, `${signature} closes`).toBeGreaterThan(start);
  return app.slice(start, end);
}

describe("the composer's growth cap", () => {
  it("reads the declared ceiling rather than the one it wrote last time", () => {
    // `composerGrowthCap` is `max(min, min(declared, share of the viewport))`,
    // so it can only ever shrink its input. Feeding it the previous inline
    // result made every refit a ratchet: one soft-keyboard raise on a phone —
    // or one split-screen drag on a desktop — capped the composer at a third
    // of the shrunken viewport for the life of the page, and dismissing the
    // keyboard could never give the 180px back.
    const fit = functionBody("function fitComposerTextarea");
    const cleared = fit.indexOf('element.style.maxHeight = "";');
    const measured = fit.indexOf("getComputedStyle(element)");
    expect(cleared, "the inline ceiling is dropped before a ceiling is read").toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(measured);
    expect(fit).toContain("parseFloat(style.maxHeight)");
  });

  it("collapses an emptied composer without asking the box how tall it is", () => {
    /*
     * The other half of the same box, and the one the cap repair left open.
     * Measured at every width the sweep captures, 320 through 1920: clear a
     * long draft and the textarea stayed at exactly the cap, an empty bordered
     * box roughly 200px tall carrying a placeholder and nothing else, with the
     * transcript pushed off the phone entirely. Three separate paths already
     * refit on the cleared value — the element's `input` event, the JSX
     * handler, and the layout effect keyed on `[input]` — and all three
     * measured the same stuck `scrollHeight`, so the fix cannot be another
     * refit. An empty value's height is not a measurement: it is the minimum.
     */
    const fit = functionBody("function fitComposerTextarea");
    expect(fit, "emptiness resolves to the resting height, growth is still measured")
      .toContain("const natural = element.value ? element.scrollHeight : minimum;");
  });
});

describe("a failed turn's footer", () => {
  it("carries the classified cause into the card, not only into the topbar", () => {
    // `turnRecoverySummary` was given a table of causes — rate limit, out of
    // credit, access rejected, provider unreachable — and a literal `undefined`
    // for the kind, so every one of them fell through to "offline"/"unknown"
    // and the card under the reader's eye said the least it could while the
    // mapped sentence went to the topbar alone.
    expect(app, "the mapped failure is bound, not reduced to its sentence")
      .toContain(".then(({ mapUnknownRequestFailure }) => mapUnknownRequestFailure(error, online))\n");
    expect(app, "the kind reaches the recovery footer")
      .toContain('recovery.recoverPartialTurn(message.parts ?? [], "", pending, cancelled, mapped?.kind,');
    expect(app, "no caller passes the classification as undefined")
      .not.toContain('pending, cancelled, undefined,');
  });
});

describe('"Return to this turn"', () => {
  const effectStart = app.indexOf("const request = pendingTranscriptReturn;");
  const effect = app.slice(effectStart, app.indexOf("}, [view, sessionId, messages, pendingTranscriptReturn]);", effectStart));

  it("scrolls to the turn by geometry instead of scanning only the mounted rows", () => {
    // The transcript is virtualised past 60 rows, so a turn five prompts into a
    // long conversation is simply not in the DOM. `focusTranscriptTurn` sees
    // mounted cards only, so the control reported "not-rendered", blamed local
    // commands, and left the reader exactly where they stood.
    expect(effectStart, "the return effect exists").toBeGreaterThan(-1);
    expect(effect).toContain("messages.findIndex((message) => message.receipt?.turnId === request.turnId)");
    expect(effect).toContain("windowedTranscript.offsetForIndex(index)");
    expect(effect, "the landing is retried while measured heights replace estimates").toContain("pass < 8");
  });

  it("blames a local command only where no message in the transcript carries the id", () => {
    const unresolved = effect.indexOf("if (index < 0)");
    const localCommand = effect.indexOf("a local command mints no receipt");
    expect(unresolved, "the unresolved branch exists").toBeGreaterThan(-1);
    expect(localCommand, "the sentence is kept for the case it is true about").toBeGreaterThan(unresolved);
    expect(localCommand, "and is spent there, before anything tries to scroll")
      .toBeLessThan(effect.indexOf("const element = transcriptElement.current;"));
  });

  it("is declared after the window it measures against", () => {
    // Not a style point: `windowedTranscript` is declared below the effect's
    // former home, and reading it from there is a temporal dead zone.
    expect(app.indexOf("const windowedTranscript = useWindowedTranscript({")).toBeLessThan(effectStart);
  });
});

describe("editing a queued message", () => {
  const body = functionBody("  function editQueuedMessage(");

  it("refuses rather than trading an unsent draft for the queued one", () => {
    // The queue panel is only on screen while a turn runs, which is precisely
    // when the composer holds the next follow-up. Every other restore path in
    // this file guards the draft; this one overwrote text and attachments with
    // no confirmation and no undo.
    const refusal = body.indexOf("if (input.trim() || attachments.length)");
    expect(refusal, "the guard exists").toBeGreaterThan(-1);
    expect(body).toContain('setComposerNotice("Clear or queue the composer before editing a queued message");');
    expect(refusal, "and refuses before the item is taken out of the queue")
      .toBeLessThan(body.indexOf("removeQueuedMessage(sessionId, item.id);"));
  });

  it("does not lift the Stop that paused this conversation's queue", () => {
    // An explicit send is the only thing that lifts a Stop. Pulling an item
    // back to the composer is not a send, and resuming there dispatched the
    // very turns the reader pressed Stop to prevent.
    expect(body, "the comment may name the rule; nothing here may call it")
      .not.toContain("setQueuePausedForSession(");
  });
});

describe("opening a conversation with no active one", () => {
  it("names the refusal and keeps the clicked row in view", () => {
    // Deleting the active conversation clears the session identity every open
    // is performed against, and nothing re-establishes it until the reader
    // mints a new conversation. The bail is right; being silent about it made
    // every rail click land in an unselected library for no stated reason.
    const body = functionBody("  async function openPaletteSession(");
    const bail = body.slice(0, body.indexOf("try {"));
    expect(bail).toContain("setSessionsFocusId(targetSessionId);");
    expect(bail).toContain("No conversation is open, so there is no active runtime to open this one against.");
    expect(bail).not.toContain('{ navigate("sessions"); return; }');
  });
});

describe("the deferred message-parts renderer", () => {
  it("states the words plainly when its chunk never arrives", () => {
    // `loadRetryableChunk` rejects on a terminal failure by design. With no
    // catch, `View` stayed undefined for the life of the mount and every row
    // holding parts rendered as a labelled empty card — a transcript that
    // looked wiped — while the rejection went unhandled.
    const body = functionBody("function DeferredMessageParts(");
    expect(body).toContain("if (live) setFailed(true);");
    expect(body).toContain("messagePlainText(props.parts)");
  });

  it("terminates both chunk warms inside the shared idle callback", () => {
    const start = app.indexOf("    const warm = () => {");
    const warm = app.slice(start, app.indexOf("    };", start));
    expect(start, "the shared post-paint warm exists").toBeGreaterThan(-1);
    expect(warm).toContain("loadMessageParts().catch(() => undefined)");
    expect(warm).toContain("loadAgentRuntimeStatus().catch(() => undefined)");
    expect(warm, "the overlays keep the same post-paint fetch timing")
      .toContain("beginPlatformOverlaysLoad();");
    expect(app, "the idle callback keeps its bounded fallback")
      .toContain('requestIdleCallback(warm, { timeout: 2_000 });\n    else setTimeout(warm, 0);');
    expect(app).not.toContain("function warmMessageParts()");
    expect(app).not.toContain("function warmAgentRuntimeStatus()");
  });
});

describe("Send during a conversation or Profile transition", () => {
  it("names the wait instead of returning false in silence", () => {
    // `composerTransitionPending` mirrors three of the latches into the
    // surface; these two have no mirror, so Send stayed enabled, the legend
    // still read "↵ send", and Enter did nothing at all for the length of a
    // fork or a Profile storage change.
    const body = functionBody("  async function sendMessage(");
    const silent = body.slice(body.indexOf("if (\n      !content"), body.indexOf(") return false;"));
    expect(silent, "the silent bail exists").toContain("!runtime.current");
    expect(silent).not.toContain("sessionNavigationChanging");
    expect(silent).not.toContain("catalogAuthorityChanging");
    expect(body).toContain('if (sessionNavigationChanging.current || catalogAuthorityChanging.current) {');
    expect(body, "in the sentence the equivalent authority mismatch already uses")
      .toContain('setComposerNotice("Wait for the active Profile and conversation to finish binding before sending.");');
  });
});

describe("the profile editor's theme preview", () => {
  it("stops calling the previewed theme unsaved once the revision is saved", () => {
    // `save()` leaves the preview armed on purpose — the paint bookkeeping and
    // its unmount restore depend on it — so the strip read "Previewing — not
    // saved" beside "Revision saved to the encrypted Vault", and a reader who
    // believed the label pressed "Cancel preview" on a theme that was kept.
    expect(app).toContain('previewThemeId === selected.theme.themeId ? "Previewing this profile\'s saved theme" : "Previewing — not saved"');
  });
});

describe("local command runtime authority", () => {
  it("fences identity with the published runtime while executing with the session projection", () => {
    const current = functionBody("function localPresentationAuthorityIsCurrent");
    const builtin = functionBody("async function runSlashBuiltin");
    expect(current).toContain("runtime.current === authority.identityRuntime");
    expect(builtin).toContain("const commandRuntime = authority.commandRuntime;");
    expect(builtin).not.toContain("runtime.current !== commandRuntime");
    expect(builtin).toContain("runtime: authority.identityRuntime");
    expect(app).toContain("identityRuntime: ambientRuntime");
    expect(app).toContain("commandRuntime: admissionRuntime");
    expect(current).not.toContain("runtime.current === authority.commandRuntime");
  });
});

describe("the shell's own status vocabulary", () => {
  /*
   * Three uses of one word, before a newcomer has typed anything.
   *
   * Measured on a cold load of the built tree at 3114a9b, both viewports:
   * `document.body.textContent` contained "kernel" three times — the topbar
   * runtime line, the phone band that mirrors it, and the boot heading
   * "Preparing the local kernel" — and the only live region with any text in
   * it announced "Local kernel ready", which is therefore the first sentence a
   * screen-reader user is given. There is no kernel in a person's model of a
   * chat page; there is a device, and there is a page that is starting.
   *
   * These strings still state exactly what they stated: that Airship is
   * starting or ready, and that it is this device doing it. Nothing became
   * vaguer, and the failure sentence keeps the fact a reader has to act on —
   * that this tab never became ready.
   */
  const statusStrings = [
    'const RUNTIME_STARTING_STATUS = "Starting Airship on this device";',
    'const RUNTIME_READY_STATUS = "Airship is ready on this device";',
    '"Airship could not finish starting on this device. Reload to try again; this tab never became ready."',
    '<h1>{failure ? "Airship did not start on this device" : "Preparing Airship on this device"}</h1>',
  ];

  it("says starting and ready in words a first-time reader already has", () => {
    for (const statement of statusStrings) expect(app, statement).toContain(statement);
  });

  it("keeps one spelling of each status, so the line and its mirror cannot disagree", () => {
    // Each is written at two call sites — the state seed and the mirror, the
    // boot path and the turn-settled path.
    expect(app).toContain("useState(RUNTIME_STARTING_STATUS)");
    expect(app).toContain("setRuntimeStatus(RUNTIME_READY_STATUS)");
    expect(app.split('"Starting Airship on this device"')).toHaveLength(2);
    expect(app.split('"Airship is ready on this device"')).toHaveLength(2);
  });

  it("keeps no rendered string that calls the runtime a kernel", () => {
    /*
     * Comments may still describe the history — this file's own paragraph
     * above does — so the comments come out first and only the double-quoted
     * strings that survive are read.
     */
    const code = app.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
    const spoken = [...code.matchAll(/"([^"\n]{4,})"/gu)]
      .map((match) => match[1])
      .filter((value) => /kernel/iu.test(value));
    expect(spoken, "no rendered sentence calls it a kernel").toEqual([]);
  });

  it("still holds the ambient line out of the polite channel while a turn speaks", () => {
    // The plainer sentence is set at the same instant a turn settles, so the
    // stand-down that keeps two polite regions from mutating in one frame has
    // to survive the rewording that made it readable.
    expect(app).toContain("if (turnNarration.holdsChannel()) return;");
    expect(app).toContain("const [runtimeAnnouncement, setRuntimeAnnouncement] = useState(RUNTIME_STARTING_STATUS);");
  });
});
