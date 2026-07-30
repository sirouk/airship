import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "./icons";

/**
 * The one "nothing here yet" recipe.
 *
 * Measured defect: this component was written, styled in `routes.css`
 * (`.empty-state`, `min-height: 330px`), and then rendered nowhere — it sat as
 * a private helper inside `app.tsx`'s 11k lines where no route could import
 * it. So ten routes drew their own instead, and "nothing here yet" now ships
 * at four different heights (`.session-library-empty` 180px,
 * `.context-empty` 260px, `.empty-state` 330px, `.workbench-empty`
 * flex-fill), two inks and two heading levels. On a 390px phone the difference
 * between a 180px and a 330px void is most of the viewport, so walking
 * Sessions → Attestations → Workspace with an empty account reads as three
 * products.
 *
 * It lives in a leaf module — `Icon` is its only dependency — so every route
 * can reach it, and so the recipe is a reference rather than a copy.
 */
export type EmptyStateProps = Readonly<{
  icon: IconName;
  title: string;
  body: string;
  /**
   * The verb that ends the emptiness, where the route has one.
   *
   * Four of the routes that hand-rolled this state did so only because they
   * needed a button under the sentence (Sessions' "Start a conversation",
   * Context's index trigger, Source Control's import, the Workbench's open).
   * A recipe that cannot hold their button is a recipe they will fork again.
   */
  action?: ComponentChildren;
}>;

export function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div class="empty-state">
      <Icon name={icon} />
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}
