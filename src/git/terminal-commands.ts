import type { BrowserGitClient } from "./client";
import { describeGitOperation } from "./operations";
import { normalizeWorkspacePath } from "../workspace/contracts";
import type {
  GitAuthor,
  GitOperation,
  GitOperationDescriptor,
  GitRepositorySnapshot,
  GitStatusEntry,
  GitWorktreeSnapshot,
} from "./types";

const MAX_COMMAND_CHARS = 8_192;
const MAX_DIFF_PATHS = 64;
const MAX_OUTPUT_CHARS = 256 * 1_024;

export type TerminalGitReview = (
  operation: GitOperation,
  descriptor: GitOperationDescriptor,
) => Promise<"allow" | "deny">;

export type TerminalGitResult = Readonly<{
  output: string;
  changed: boolean;
}>;

/**
 * Deterministic Git command bridge for the interactive browser terminal.
 * Commands dispatch to BrowserGitClient, so terminal Git, Editor, agent tools,
 * and source control all observe one revision-fenced WorkspacePort state.
 * Nothing here invokes a host shell or a second repository implementation.
 */
export async function runTerminalGitCommand(args: Readonly<{
  command: string;
  cwd: string;
  client: BrowserGitClient;
  review?: TerminalGitReview;
  author?: GitAuthor;
  signal?: AbortSignal;
}>): Promise<TerminalGitResult> {
  const words = tokenize(args.command);
  if (words.shift() !== "git") throw new Error("The shared Git bridge accepts commands beginning with `git`.");
  const signal = args.signal ?? new AbortController().signal;
  let cwd = args.cwd;
  if (words[0] === "-C") {
    words.shift();
    const selected = words.shift();
    if (!selected) throw new Error("git -C requires an Airship workspace path.");
    cwd = resolveCwd(args.cwd, selected);
  }
  const command = words.shift() ?? "help";
  const repositories = await args.client.listRepositories(signal);

  if (command === "help" || command === "--help") return result(help(), false);
  if (command === "clone") return clone(args.client, repositories, words, args.review, signal);

  const selected = selectRepository(repositories, cwd);
  if (!selected) {
    throw new Error(`No browser-owned Git worktree contains ${cwd}. Use \`git clone\` or open a registered workspace path.`);
  }
  const { repository, worktree } = selected;

  switch (command) {
    case "status":
      return result(formatStatus(await args.client.status(target(repository, worktree), signal)), false);
    case "diff":
      return diff(args.client, repository, worktree, words, signal);
    case "add":
      return stage(args.client, repository, worktree, words, args.review, signal);
    case "reset":
      return unstage(args.client, repository, worktree, words, args.review, signal);
    case "restore":
      if (words.shift() !== "--staged") throw new Error("The browser bridge currently supports `git restore --staged [paths…]` only.");
      return unstage(args.client, repository, worktree, words, args.review, signal);
    case "commit":
      return commit(args.client, repository, worktree, words, args.author, args.review, signal);
    case "branch":
      return branch(args.client, repository, worktree, words, args.review, signal);
    case "switch":
    case "checkout":
      return switchBranch(args.client, repository, worktree, words, args.review, signal);
    case "fetch":
      return fetchRemote(args.client, repository, words, args.review, signal);
    case "push":
      return pushRemote(args.client, repository, worktree, words, args.review, signal);
    case "remote":
      if (words.length && words[0] !== "-v") throw new Error("The browser bridge supports `git remote` and `git remote -v` inspection only.");
      return result(repository.remotes.length
        ? repository.remotes.map((remote) => words[0] === "-v" ? `${remote.name}\t${remote.url} (fetch)` : remote.name).join("\n")
        : "No remotes configured.", false);
    case "rev-parse":
      return result(revParse(repository, worktree, words), false);
    case "worktree":
      throw new Error(args.client.capabilities.features[command].reason ?? `git ${command} is unavailable in this browser adapter.`);
    default:
      throw new Error(`Unsupported shared Git command: git ${command}. Run \`git help\` for the deterministic command set.`);
  }
}

async function diff(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  const staged = args[0] === "--cached" || args[0] === "--staged";
  if (staged) args.shift();
  if (args[0] === "--") args.shift();
  const live = await client.status(target(repository, current), signal);
  const paths = args.length
    ? args
    : live.status.filter((entry) => staged ? entry.index : entry.worktree).map((entry) => entry.path);
  if (!paths.length) return result("No differences.", false);
  const selected = paths.slice(0, MAX_DIFF_PATHS);
  const patches = await Promise.all(selected.map((path) => client.diff({
    ...target(repository, live),
    path,
    scope: staged ? "staged" : "worktree",
  }, signal)));
  const suffix = paths.length > selected.length ? `\nDiff limited to ${MAX_DIFF_PATHS} paths; ${paths.length - selected.length} omitted.` : "";
  return result(`${patches.map((item) => item.patch || `${item.path}: no difference\n`).join("")}${suffix}`, false);
}

async function stage(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  const live = await client.status(target(repository, current), signal);
  const paths = args.length && !args.includes("-A") && !args.includes("--all") && !args.includes(".")
    ? stripSeparator(args)
    : live.status.filter((entry) => entry.worktree).map((entry) => entry.path);
  if (!paths.length) return result("No unstaged paths to add.", false);
  const operation: GitOperation = { kind: "stage", request: { ...target(repository, live), paths, expectedWorktreeVersion: live.version } };
  await approve(operation, review);
  const changed = await client.stage(operation.request, signal);
  return result(`Staged ${changed.changedPaths.length} path${changed.changedPaths.length === 1 ? "" : "s"}.`, true);
}

async function unstage(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  const live = await client.status(target(repository, current), signal);
  const requested = stripSeparator(args).filter((word) => word !== "HEAD");
  const paths = requested.length ? requested : live.status.filter((entry) => entry.index).map((entry) => entry.path);
  if (!paths.length) return result("No staged paths to restore.", false);
  const operation: GitOperation = { kind: "unstage", request: { ...target(repository, live), paths, expectedWorktreeVersion: live.version } };
  await approve(operation, review);
  const changed = await client.unstage(operation.request, signal);
  return result(`Unstaged ${changed.changedPaths.length} path${changed.changedPaths.length === 1 ? "" : "s"}.`, true);
}

async function commit(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  author: GitAuthor | undefined,
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  const messageIndex = args.findIndex((word) => word === "-m" || word === "--message");
  const message = messageIndex >= 0 ? args[messageIndex + 1] : undefined;
  if (!message || args.length !== 2) throw new Error("Use `git commit -m \"message\"` in the browser bridge.");
  const live = await client.status(target(repository, current), signal);
  const operation: GitOperation = {
    kind: "commit",
    request: {
      ...target(repository, live),
      message,
      author: author ?? { name: "Local Airship User", email: "airship@local.invalid" },
      expectedWorktreeVersion: live.version,
    },
  };
  await approve(operation, review);
  const changed = await client.commit(operation.request, signal);
  return result(`[${changed.worktree?.branch ?? live.branch} ${changed.commit?.slice(0, 12)}] ${message}`, true);
}

async function branch(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  if (!args.length) return result(repository.branches.map((item) => `${item.current ? "*" : " "} ${item.name}`).join("\n"), false);
  if (args.length !== 1) throw new Error("Use `git branch` or `git branch <name>` in the browser bridge.");
  const live = await client.status(target(repository, current), signal);
  const operation: GitOperation = { kind: "branch-create", request: { ...target(repository, live), name: args[0]!, checkout: false, expectedWorktreeVersion: live.version } };
  await approve(operation, review);
  await client.createBranch(operation.request, signal);
  return result(`Created branch ${args[0]}.`, true);
}

async function switchBranch(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  const create = args[0] === "-c" || args[0] === "-b";
  if (create) args.shift();
  if (args.length !== 1) throw new Error("Use `git switch <branch>` or `git switch -c <branch>` in the browser bridge.");
  const live = await client.status(target(repository, current), signal);
  const operation: GitOperation = create
    ? { kind: "branch-create", request: { ...target(repository, live), name: args[0]!, checkout: true, expectedWorktreeVersion: live.version } }
    : { kind: "branch-switch", request: { ...target(repository, live), name: args[0]!, expectedWorktreeVersion: live.version } };
  await approve(operation, review);
  if (operation.kind === "branch-create") await client.createBranch(operation.request, signal);
  else await client.switchBranch(operation.request, signal);
  return result(`Switched to branch ${args[0]}.`, true);
}

async function fetchRemote(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  if (args.length > 1) throw new Error("Use `git fetch [remote]` in the browser bridge.");
  const remote = args[0] ?? repository.remotes[0]?.name;
  if (!remote) throw new Error("This repository has no configured remote.");
  const latest = await client.getRepository(repository.id, signal);
  if (!latest) throw new Error("The repository disappeared before fetch.");
  const operation: GitOperation = { kind: "fetch", request: { repositoryId: repository.id, remote, expectedRepositoryVersion: latest.version, prune: true } };
  await approve(operation, review);
  await client.fetch(operation.request, signal);
  return result(`Fetched ${remote} directly with browser Git Smart HTTP.`, true);
}

async function pushRemote(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  worktree: GitWorktreeSnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  if (args.some((value) => value.startsWith("-")) || args.length > 2) {
    throw new Error("Use `git push [remote] [branch]` in the browser bridge. Force push requires the explicit Source Control review surface.");
  }
  if (!client.capabilities.features.push.available) {
    throw new Error(client.capabilities.features.push.reason ?? "Direct browser push is unavailable.");
  }
  const remote = args[0] ?? repository.remotes[0]?.name;
  if (!remote) throw new Error("This repository has no configured remote.");
  const branch = args[1] ?? worktree.branch;
  const live = await client.status(target(repository, worktree), signal);
  const operation: GitOperation = {
    kind: "push",
    request: {
      repositoryId: repository.id,
      worktreeId: live.id,
      remote,
      branch,
      expectedWorktreeVersion: live.version,
      force: false,
    },
  };
  await approve(operation, review);
  await client.push(operation.request, signal);
  return result(`Pushed ${branch} to ${remote} directly with browser Git Smart HTTP.`, true);
}

async function clone(
  client: BrowserGitClient,
  repositories: readonly GitRepositorySnapshot[],
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  if (args.length < 1 || args.length > 2) throw new Error("Use `git clone <https-url> [workspace-destination]` in the browser bridge.");
  const url = new URL(args[0]!);
  const base = url.pathname.replace(/\.git$/u, "").split("/").filter(Boolean).at(-1) ?? "repository";
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+/u, "repo-").slice(0, 72) || "repository";
  let id = `clone-${slug}`;
  for (let suffix = 2; repositories.some((item) => item.id === id); suffix += 1) id = `clone-${slug}-${suffix}`;
  const destination = args[1] ?? `/workspace/sources/${slug}`;
  const operation: GitOperation = { kind: "clone", request: { repositoryId: id, name: base, remoteUrl: url.toString(), destination } };
  await approve(operation, review);
  const cloned = await client.clone(operation.request, signal);
  return result(`Cloned ${url.origin}${url.pathname} into ${cloned.worktree?.path ?? destination}.`, true);
}

function revParse(repository: GitRepositorySnapshot, worktree: GitWorktreeSnapshot, args: string[]): string {
  if (args.length !== 1) throw new Error("The browser bridge supports `git rev-parse HEAD`, `--show-toplevel`, or `--is-inside-work-tree`.");
  if (args[0] === "HEAD") return worktree.head;
  if (args[0] === "--show-toplevel") return worktree.path;
  if (args[0] === "--is-inside-work-tree") return "true";
  if (args[0] === "--abbrev-ref") throw new Error("Use `git branch` to inspect the current branch.");
  throw new Error(`Unsupported rev-parse argument: ${args[0]}.`);
}

async function approve(operation: GitOperation, review: TerminalGitReview | undefined): Promise<void> {
  if (!review) throw new Error("Mutating terminal Git commands require the active Airship approval policy.");
  if (await review(operation, describeGitOperation(operation)) !== "allow") {
    throw new Error("Git operation denied; the shared workspace was not changed.");
  }
}

function selectRepository(repositories: readonly GitRepositorySnapshot[], cwd: string) {
  return repositories.flatMap((repository) => repository.worktrees.map((worktree) => ({ repository, worktree })))
    .filter(({ worktree }) => cwd === worktree.path || cwd.startsWith(`${worktree.path}/`))
    .sort((left, right) => right.worktree.path.length - left.worktree.path.length)[0];
}

function target(repository: GitRepositorySnapshot, worktree: GitWorktreeSnapshot) {
  return { repositoryId: repository.id, worktreeId: worktree.id };
}

function formatStatus(worktree: GitWorktreeSnapshot): string {
  if (!worktree.status.length) return `On branch ${worktree.branch}\nnothing to commit, working tree clean`;
  const rows = worktree.status.map((entry) => `${delta(entry.index)}${delta(entry.worktree)} ${entry.path}`);
  return `On branch ${worktree.branch}\n${rows.join("\n")}`;
}

function delta(value: GitStatusEntry["index"]): string {
  if (!value) return " ";
  return value.kind === "added" ? "A" : value.kind === "deleted" ? "D" : value.kind === "renamed" ? "R" : value.kind === "conflicted" ? "U" : "M";
}

function resolveCwd(current: string, selected: string): string {
  if (selected === ".") return normalizeWorkspacePath(current);
  return normalizeWorkspacePath(selected.startsWith("/")
    ? selected
    : `${current.replace(/\/+$/u, "")}/${selected}`);
}

function stripSeparator(args: readonly string[]): string[] {
  return args.filter((word) => word !== "--");
}

function tokenize(command: string): string[] {
  if (!command.trim() || command.length > MAX_COMMAND_CHARS || /[\u0000\r\n]/u.test(command)) {
    throw new Error("Git command must be one bounded terminal line.");
  }
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;
  for (const character of command.trim()) {
    if (escaping) { word += character; escaping = false; started = true; continue; }
    if (character === "\\" && quote !== "'") { escaping = true; started = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/u.test(character)) {
      if (started) { words.push(word); word = ""; started = false; }
      continue;
    }
    word += character;
    started = true;
  }
  if (escaping || quote) throw new Error("Git command contains an unfinished quote or escape.");
  if (started) words.push(word);
  return words;
}

function help(): string {
  return [
    "Airship shared Git bridge (real browser-owned .git state)",
    "  git status",
    "  git diff [--staged] [--] [paths…]",
    "  git add <paths…> | git add -A",
    "  git restore --staged [paths…] | git reset [HEAD] [paths…]",
    "  git commit -m \"message\"",
    "  git branch [name] | git switch [-c] <name>",
    "  git remote [-v] | git fetch [remote]",
    "  git push [remote] [branch]",
    "  git clone <https-url> [workspace-destination]",
    "  git rev-parse HEAD|--show-toplevel|--is-inside-work-tree",
    "Remote traffic is direct Smart HTTP and requires browser CORS. No proxy or Airship backend is inserted.",
  ].join("\n");
}

function result(output: string, changed: boolean): TerminalGitResult {
  const bounded = output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated …` : output;
  return Object.freeze({ output: bounded.replace(/\n?$/u, "\n"), changed });
}
