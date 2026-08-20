import type { JSX } from "preact";

export type IconName =
  | "airship"
  | "chat"
  | "sessions"
  | "workspace"
  | "source"
  | "context"
  | "memory"
  | "profiles"
  | "skills"
  | "model"
  | "access"
  | "settings"
  | "send"
  | "stop"
  | "file"
  | "edit"
  | "branch"
  | "check"
  | "warning"
  | "lock"
  | "cloud"
  | "moon"
  | "sun"
  | "terminal"
  | "plus"
  | "refresh"
  | "trash"
  | "storage-device"
  | "storage-s3"
  | "storage-ephemeral";

const paths: Record<IconName, JSX.Element> = {
  airship: <path d="M6.5 12h11M12 6.5V12" />,
  chat: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.7A2.5 2.5 0 0 1 4 12.5z" />,
  sessions: <path d="M6 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4h8M8 11h5M3 8H2v9a2 2 0 0 0 2 2" />,
  workspace: <path d="M3.5 6.5h7l2-2h8v15h-17zM3.5 9.5h17" />,
  source: <path d="M7 4v16M17 4v5a3 3 0 0 1-3 3H7m10-3-3-3m3 3 3-3" />,
  context: <path d="M5 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm14 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 21.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM7.2 6.3l3.6 10.4m6-10.4-3.6 10.4M7.5 5h9" />,
  memory: <path d="M12 3a3 3 0 0 0-3 3v.3A3.5 3.5 0 0 0 5.5 9.8c0 .7.2 1.4.6 2A3.6 3.6 0 0 0 8 18.4V19a2 2 0 0 0 4 0zm0 0a3 3 0 0 1 3 3v.3a3.5 3.5 0 0 1 3.5 3.5c0 .7-.2 1.4-.6 2a3.6 3.6 0 0 1-1.9 6.6V19a2 2 0 0 1-4 0m-3-9.5c.9 0 1.7.4 2.3 1.1M15 9.5c-.9 0-1.7.4-2.3 1.1M8.5 14c1 0 1.8.4 2.4 1.2M15.5 14c-1 0-1.8.4-2.4 1.2" />,
  profiles: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.5 8a7.5 7.5 0 0 1 15 0M18.5 5.5h3m-1.5-1.5v3" />,
  skills: <path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7zm6 10 .9 2.1L21 16l-2.1.9L18 20l-.9-3.1L15 16l2.1-.9zM6 14l.8 2.2L9 17l-2.2.8L6 20l-.8-2.2L3 17l2.2-.8z" />,
  model: <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zm0 0v9m8-4.5-8 4.5-8-4.5m8 4.5v9" />,
  access: <path d="M7.5 11V7a4.5 4.5 0 0 1 9 0v4m-11 0h13v10h-13zM12 15v2.5" />,
  /* Preferences wore `model` — the same glyph as the model control beside it in
     the top bar, so two different controls read as one. Six teeth, drawn on the
     same 24 grid as the rest of the set. */
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M9.6 2.9h4.8l.5 2.6 1.3.8 2.4-.9 2.5 4.2-2 1.7v1.4l2 1.7-2.5 4.2-2.4-.9-1.3.8-.5 2.6H9.6l-.5-2.6-1.3-.8-2.4.9-2.5-4.2 2-1.7v-1.4l-2-1.7 2.5-4.2 2.4.9 1.3-.8z" /></>,
  send: <path d="m3 11 18-8-7.5 18-2-8zM11.5 13 21 3" />,
  stop: <path d="M7 7h10v10H7z" />,
  file: <path d="M6 2.5h8l4 4v15H6zM14 2.5v5h4" />,
  edit: <path d="M4 20h4l11-11-4-4L4 16zM13.5 6.5l4 4M4 20l.8-4.8" />,
  branch: <path d="M6 3v13a4 4 0 0 0 4 4h2M18 3v5a4 4 0 0 1-4 4H6m9-9h6m-6 17h6" />,
  check: <path d="m4 12 5 5L20 6" />,
  warning: <path d="M12 3 2.8 20h18.4zM12 9v4m0 3.5v.2" />,
  lock: <path d="M6 10V7a6 6 0 0 1 12 0v3m-14 0h16v11H4zM12 14v3" />,
  cloud: <path d="M7 18.5H5.5a3.5 3.5 0 0 1-.4-7A6.5 6.5 0 0 1 17.7 10a4.3 4.3 0 0 1 .8 8.5H17m-5-6v9m-3-3 3 3 3-3" />,
  moon: <path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  terminal: <path d="m4 6 5 5-5 5m8 1h8" />,
  plus: <path d="M12 4v16M4 12h16" />,
  /* Source Control's reload verb was a full word wide enough to push the panel
     into a two-column wrap. The set had no circular arrow, so this is it: one
     297° sweep of the same r=8 circle the rest of the glyphs are built on,
     leaving at -45° into the corner that reads as the head. */
  refresh: <path d="M19.6 14.5A8 8 0 1 1 17.7 6.3l3.4 3.4M21.1 4.9v4.8h-4.8" />,
  /* `sessions-view.tsx` renders this for its destructive row action; the map had
     no destructive glyph at all, so the name did not typecheck. */
  trash: <path d="M4 6.5h16M9.5 6.5V4h5v2.5M6 6.5l1 14.5h10l1-14.5M10 11v5.5m4-5.5v5.5" />,
  /* Vendor brand marks live in `brand-icons.tsx` as filled artwork; these are
     the storage destinations, kept in this set's stroke language. */
  "storage-device": <><path d="M3.5 8h17v8h-17zM3.5 8c0-2 1.6-3.5 3.5-3.5h10C18.9 4.5 20.5 6 20.5 8M3.5 16v2a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-2" /><path d="M16.5 12h.2" /></>,
  "storage-s3": <><path d="M5 8.5h14l-1.5 10a2 2 0 0 1-2 1.8h-7a2 2 0 0 1-2-1.8z" /><path d="M3.5 8.5c0-2.2 3.8-4 8.5-4s8.5 1.8 8.5 4-3.8 4-8.5 4-8.5-1.8-8.5-4z" /></>,
  /* Ephemeral: a dashed ring — present while you look at it, gone when you
     let it go. Nothing else in the set is dashed, and nothing should be. */
  "storage-ephemeral": <circle cx="12" cy="12" r="7" stroke-dasharray="3.2 2.4" />,
};

export function Icon({ name, size = 18, class: className }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      aria-hidden="true"
      class={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.65"
    >
      {paths[name]}
    </svg>
  );
}
