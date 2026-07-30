/**
 * What a destination says when its chunk did not arrive — including a way out.
 *
 * Measured defect: nine of the shell's deferred routes rendered a heading and
 * one sentence and no control of any kind when the chunk fetch dropped, while
 * the tenth (`context-route.tsx`, reached only through Memory's Index
 * disclosure) offered "Retry loading Context". The lazy loaders in `app.tsx`
 * are keyed on `[view, Screen]`, so a user who is already standing on the
 * failed route has nothing to press that re-enters them: the route is a dead
 * end until a reload. On a phone that is the whole story, because the only
 * other carrier of a load failure — `.runtime-line` — is `display: none`
 * below 640px.
 *
 * One component rather than nine branches, so a tenth phrasing of "this did
 * not load" cannot appear, and so the retry verb is written once.
 */

/** The retry verb, referenced rather than retyped by every failing route. */
export function routeRetryLabel(title: string): string {
  return `Retry loading ${title}`;
}

export type RouteFailureProps = Readonly<{
  /**
   * What failed to load, in the words the user reached it by.
   *
   * A whole route passes its rail name ("Account") and gets it as the `<h1>`.
   * A slot inside a route that *did* load passes a lowercase phrase ("the
   * claim stack"), because the route's own heading is already on screen and a
   * second `<h1>` re-titles the page.
   */
  title: string;
  /** The failure sentence, which must also state what did not change. */
  message: string;
  onRetry: () => void;
  /** A slot inside a loaded route: no heading, no route panel. */
  inline?: boolean;
  /** The host's panel class where it differs from the route default. */
  class?: string;
}>;

export function RouteFailure({ title, message, onRetry, inline = false, class: className }: RouteFailureProps) {
  const body = (
    <>
      <p>{message}</p>
      <button class="small-button" type="button" onClick={onRetry}>{routeRetryLabel(title)}</button>
    </>
  );
  return inline
    ? <div class={className ?? "panel"} role="alert">{body}</div>
    : <section class={className ?? "work-view panel"} role="alert"><h1>{title}</h1>{body}</section>;
}
