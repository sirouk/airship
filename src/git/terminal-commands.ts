import type { BrowserGitClient } from "./client";
import { describeGitOperation } from "./operations";
import { normalizeWorkspacePath } from "../workspace/contracts";
import type {
  GitAuthor,
  GitCapability,
  GitCommitSummary,
  GitOperation,
  GitOperationDescriptor,
  GitRepositorySnapshot,
  GitStatusEntry,
  GitWorktreeSnapshot,
} from "./types";
import { assertRemoteOriginPermitted } from "./validation";

const MAX_COMMAND_CHARS = 8_192;
const MAX_DIFF_PATHS = 64;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const DEFAULT_LOG_LINES = 20;
const DEFAULT_AUTHOR: GitAuthor = Object.freeze({ name: "Local Airship User", email: "airship@local.invalid" });

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
      // Only the words before `--` are options; the bare separator itself
      // starts with `--` but announces pathspecs, so reading the whole line
      // sent `git reset -- <paths…>` to the mode handler, which then answered
      // with advice to run the command that had just been typed.
      return beforeSeparator(words).some((word) => word.startsWith("--"))
        ? reset(args.client, repository, worktree, words, args.review, signal)
        : unstage(args.client, repository, worktree, words, args.review, signal);
    case "restore":
      if (words[0] === "--staged") {
        words.shift();
        return unstage(args.client, repository, worktree, words, args.review, signal);
      }
      return restore(args.client, repository, worktree, words, args.review, signal);
    case "log":
      return log(args.client, repository, worktree, words, signal);
    case "show":
      return show(args.client, repository, worktree, words, signal);
    case "tag":
      return tag(args.client, repository, words, args.author, args.review, signal);
    case "stash":
      return stash(args.client, repository, worktree, words, args.author, args.review, signal);
    case "merge":
      return merge(args.client, repository, worktree, words, args.author, args.review, signal);
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
      return remote(args.client, repository, words, args.review, signal);
    case "rev-parse":
      return result(revParse(repository, worktree, words), false);
    case "worktree":
      return worktreeCommand(args.client, repository, words, cwd, args.review, signal);
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
  // `path-ignored` tells the user to "stage it with force if you intend to
  // track it", and force is a real request field — but until this consumed the
  // flag, `git add -f build/out.js` passed the literal word `-f` through as a
  // pathspec and answered "-f has no unstaged change", so the remedy the error
  // named could only be reached by the agent tool, never by a person.
  const force = takeFlag(args, "-f") || takeFlag(args, "--force");
  const live = await client.status(target(repository, current), signal);
  const paths = args.length && !args.includes("-A") && !args.includes("--all") && !args.includes(".")
    ? stripSeparator(args)
    : live.status.filter((entry) => entry.worktree).map((entry) => entry.path);
  if (!paths.length) return result("No unstaged paths to add.", false);
  const operation: GitOperation = { kind: "stage", request: { ...target(repository, live), paths, force, expectedWorktreeVersion: live.version } };
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
  // Only `git restore --staged` can route a flag here, and the one it can
  // route (`--worktree`) asks for a second destination this bridge does not
  // restore in the same operation. Refusing beats silently unstaging a path
  // literally named `--worktree` and leaving the working tree untouched.
  const unsupported = unsupportedFlag(args);
  if (unsupported) {
    throw new Error(`Unsupported \`git restore --staged\` flag: ${unsupported}. Unstage first, then run \`git restore <paths…>\` to discard the working-tree change.`);
  }
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
      author: author ?? DEFAULT_AUTHOR,
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

async function log(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  requireFeature(client, "history", "Commit history");
  const words = [...args];
  const oneline = takeFlag(words, "--oneline");
  let depth = DEFAULT_LOG_LINES;
  const countIndex = words.findIndex((word) => word === "-n" || word === "--max-count");
  if (countIndex >= 0) {
    const value = Number(words[countIndex + 1]);
    if (!Number.isSafeInteger(value)) throw new Error("Use `git log -n <count>` with a whole number.");
    depth = value;
    words.splice(countIndex, 2);
  }
  const separator = words.indexOf("--");
  const paths = separator >= 0 ? words.splice(separator).slice(1) : [];
  if (paths.length > 1) throw new Error("The browser bridge follows one path per `git log -- <path>`.");
  if (words.length > 1) throw new Error("Use `git log [-n <count>] [--oneline] [<revision>] [-- <path>]` in the browser bridge.");
  const commits = await client.log({
    ...target(repository, current),
    depth,
    ...(words[0] ? { ref: words[0] } : {}),
    ...(paths[0] ? { path: paths[0], follow: true } : {}),
  }, signal);
  if (!commits.length) return result("No commits.", false);
  return result(commits.map((commit) => formatCommit(commit, oneline)).join(oneline ? "\n" : "\n\n"), false);
}

async function show(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  requireFeature(client, "history", "Commit history");
  if (args.length > 1) throw new Error("Use `git show [<revision>]` in the browser bridge.");
  const detail = await client.show({
    ...target(repository, current),
    revision: args[0] ?? current.head,
  }, signal);
  const patches = detail.files.map((file) => file.patch || `${file.path}: ${file.kind}\n`).join("");
  const suffix = detail.truncated ? "\n… more paths in this commit than the browser bridge renders …" : "";
  return result(`${formatCommit(detail.commit, false)}\n\n${patches}${suffix}`, false);
}

async function tag(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  args: string[],
  author: GitAuthor | undefined,
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  requireFeature(client, "tag", "Tagging");
  if (!args.length || args[0] === "-l" || args[0] === "--list") {
    const tags = await client.listTags(repository.id, signal);
    return result(tags.length ? tags.map((item) => `${item.name}${item.annotated ? "\t(annotated)" : ""}`).join("\n") : "No tags.", false);
  }
  const latest = await requireLatest(client, repository, signal);
  if (args[0] === "-d" || args[0] === "--delete") {
    if (args.length !== 2) throw new Error("Use `git tag -d <name>` in the browser bridge.");
    const operation: GitOperation = { kind: "tag-delete", request: { repositoryId: repository.id, name: args[1]!, expectedRepositoryVersion: latest.version } };
    await approve(operation, review);
    await client.deleteTag(operation.request, signal);
    return result(`Deleted tag ${args[1]}.`, true);
  }
  const words = [...args];
  const annotated = takeFlag(words, "-a") || takeFlag(words, "--annotate");
  const messageIndex = words.findIndex((word) => word === "-m" || word === "--message");
  let message: string | undefined;
  if (messageIndex >= 0) {
    message = words[messageIndex + 1];
    if (!message) throw new Error("Use `git tag -a <name> -m \"message\"` in the browser bridge.");
    words.splice(messageIndex, 2);
  }
  if (annotated && message === undefined) throw new Error("An annotated tag needs `-m \"message\"` in the browser bridge.");
  if (!words.length || words.length > 2) throw new Error("Use `git tag <name> [<revision>]` in the browser bridge.");
  const operation: GitOperation = {
    kind: "tag-create",
    request: {
      repositoryId: repository.id,
      name: words[0]!,
      ...(words[1] ? { ref: words[1] } : {}),
      ...(message === undefined ? {} : { message, author: author ?? DEFAULT_AUTHOR }),
      expectedRepositoryVersion: latest.version,
    },
  };
  await approve(operation, review);
  await client.createTag(operation.request, signal);
  return result(`Created ${message === undefined ? "tag" : "annotated tag"} ${words[0]}.`, true);
}

async function stash(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  author: GitAuthor | undefined,
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  requireFeature(client, "stash", "Stashing");
  const words = [...args];
  const verb = words[0] && !words[0].startsWith("-") ? words.shift()! : "push";
  if (verb === "list") {
    const entries = await client.listStash(target(repository, current), signal);
    return result(entries.length ? entries.map((entry) => `stash@{${entry.index}}: ${entry.message}`).join("\n") : "No stash entries.", false);
  }
  if (verb !== "push" && verb !== "pop" && verb !== "apply" && verb !== "drop" && verb !== "clear") {
    throw new Error("The browser bridge supports `git stash [push|pop|apply|drop|clear|list]`.");
  }
  let message: string | undefined;
  const messageIndex = words.findIndex((word) => word === "-m" || word === "--message");
  if (messageIndex >= 0) {
    message = words[messageIndex + 1];
    if (!message) throw new Error("Use `git stash push -m \"message\"` in the browser bridge.");
    words.splice(messageIndex, 2);
  }
  const index = words.length ? stashIndex(words[0]!) : 0;
  if (words.length > 1) throw new Error("Use `git stash <verb> [stash@{n}]` in the browser bridge.");
  const live = await client.status(target(repository, current), signal);
  const operation: GitOperation = {
    kind: "stash",
    request: {
      ...target(repository, live),
      op: verb,
      ...(message === undefined ? {} : { message }),
      index,
      author: author ?? DEFAULT_AUTHOR,
      expectedWorktreeVersion: live.version,
    },
  };
  await approve(operation, review);
  await client.stash(operation.request, signal);
  return result(verb === "push" ? "Stashed tracked worktree and index changes." : `Ran git stash ${verb}.`, true);
}

async function merge(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  author: GitAuthor | undefined,
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  requireFeature(client, "merge", "Merging");
  const words = [...args];
  const fastForwardOnly = takeFlag(words, "--ff-only");
  const messageIndex = words.findIndex((word) => word === "-m" || word === "--message");
  let message: string | undefined;
  if (messageIndex >= 0) {
    message = words[messageIndex + 1];
    if (!message) throw new Error("Use `git merge <branch> -m \"message\"` in the browser bridge.");
    words.splice(messageIndex, 2);
  }
  if (words.length !== 1) throw new Error("Use `git merge [--ff-only] <branch>` in the browser bridge.");
  const live = await client.status(target(repository, current), signal);
  const operation: GitOperation = {
    kind: "merge",
    request: {
      ...target(repository, live),
      theirs: words[0]!,
      fastForwardOnly,
      ...(message === undefined ? {} : { message }),
      author: author ?? DEFAULT_AUTHOR,
      expectedWorktreeVersion: live.version,
    },
  };
  await approve(operation, review);
  const merged = await client.merge(operation.request, signal);
  return result(`Merged ${words[0]} into ${merged.worktree?.branch ?? live.branch} at ${merged.worktree?.head.slice(0, 12) ?? "HEAD"}.`, true);
}

async function restore(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  requireFeature(client, "restore", "Discarding changes");
  const words = [...args];
  const fromHead = takeFlag(words, "--source=HEAD");
  // `--worktree` names Git's *destination* — restore the working tree — which
  // is exactly what this bridge already does; it is not a source selector.
  // Reading it as `--source=HEAD` overwrote staged content with HEAD on the one
  // command whose whole purpose is destroying uncommitted work, so consume it
  // as a no-op and leave the source at the index.
  takeFlag(words, "--worktree");
  const unsupported = unsupportedFlag(words);
  if (unsupported) {
    throw new Error(`Unsupported \`git restore\` flag: ${unsupported}. Use \`git restore --staged <paths…>\` to unstage, or \`git restore [--worktree] [--source=HEAD] <paths…>\` to discard working-tree changes.`);
  }
  const paths = stripSeparator(words);
  if (!paths.length) throw new Error("Use `git restore [--worktree] [--source=HEAD] <paths…>` in the browser bridge.");
  const live = await client.status(target(repository, current), signal);
  const operation: GitOperation = {
    kind: "restore",
    request: {
      ...target(repository, live),
      paths,
      source: fromHead ? "head" : "stage",
      expectedWorktreeVersion: live.version,
    },
  };
  await approve(operation, review);
  const restored = await client.restore(operation.request, signal);
  return result(`Discarded changes in ${restored.changedPaths.length} path${restored.changedPaths.length === 1 ? "" : "s"}.`, true);
}

async function reset(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  current: GitWorktreeSnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  requireFeature(client, "restore", "Resetting");
  const words = [...args];
  const mode = takeFlag(words, "--hard") ? "hard" : takeFlag(words, "--soft") ? "soft" : takeFlag(words, "--mixed") ? "mixed" : undefined;
  if (!mode) throw new Error("Use `git reset [--soft|--mixed|--hard] <revision>`, or `git reset [paths…]` to unstage.");
  if (words.length > 1) throw new Error("Use `git reset --<mode> <revision>` with one revision in the browser bridge.");
  const live = await client.status(target(repository, current), signal);
  const operation: GitOperation = {
    kind: "reset",
    request: {
      ...target(repository, live),
      mode,
      ref: words[0] ?? "HEAD",
      expectedWorktreeVersion: live.version,
    },
  };
  await approve(operation, review);
  const moved = await client.reset(operation.request, signal);
  return result(`Reset --${mode} to ${moved.worktree?.head.slice(0, 12) ?? words[0]}.`, true);
}

async function remote(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  args: string[],
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  if (!args.length || args[0] === "-v") {
    const verbose = args[0] === "-v";
    if (args.length > 1) throw new Error("Use `git remote` or `git remote -v` to inspect remotes.");
    if (!repository.remotes.length) return result("No remotes configured.", false);
    return result(repository.remotes.map((item) => verbose ? `${item.name}\t${item.url} (fetch)` : item.name).join("\n"), false);
  }
  requireFeature(client, "remote-config", "Remote configuration");
  const verb = args[0];
  const name = args[1];
  if (!name) throw new Error("Use `git remote add|set-url|remove <name> [url]` in the browser bridge.");
  const latest = await requireLatest(client, repository, signal);
  if (verb === "remove" || verb === "rm") {
    if (args.length !== 2) throw new Error("Use `git remote remove <name>` in the browser bridge.");
    const operation: GitOperation = { kind: "remote-remove", request: { repositoryId: repository.id, name, expectedRepositoryVersion: latest.version } };
    await approve(operation, review);
    await client.removeRemote(operation.request, signal);
    return result(`Removed remote ${name}.`, true);
  }
  if (verb !== "add" && verb !== "set-url") {
    throw new Error("The browser bridge supports `git remote [-v]`, `git remote add|set-url <name> <url>`, and `git remote remove <name>`.");
  }
  if (args.length !== 3) throw new Error(`Use \`git remote ${verb} <name> <https-url>\` in the browser bridge.`);
  const request = { repositoryId: repository.id, name, url: args[2]!, expectedRepositoryVersion: latest.version };
  await approve(verb === "add" ? { kind: "remote-add", request } : { kind: "remote-set-url", request }, review);
  if (verb === "add") await client.addRemote(request, signal);
  else await client.setRemoteUrl(request, signal);
  const reachable = client.capabilities.remote.permittedOrigins.includes(new URL(args[2]!).origin);
  return result(
    `${verb === "add" ? "Added" : "Repointed"} remote ${name} -> ${args[2]}.${reachable ? "" : " This build's Content-Security-Policy cannot reach that origin, so fetch and push against it will fail before any request is sent."}`,
    true,
  );
}

async function worktreeCommand(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  args: string[],
  cwd: string,
  review: TerminalGitReview | undefined,
  signal: AbortSignal,
): Promise<TerminalGitResult> {
  // The capability message may only fire when the flag is genuinely false.
  requireFeature(client, "worktree", "Linked worktrees");
  const verb = args[0] ?? "list";
  if (verb === "list") {
    if (args.length > 1) throw new Error("Use `git worktree list` in the browser bridge.");
    return result(repository.worktrees
      .map((item) => `${item.path}  ${item.head.slice(0, 7)} [${item.branch}]${item.path === repository.worktrees[0]!.path ? "  (primary)" : ""}`)
      .join("\n"), false);
  }
  if (verb === "add") {
    if (args.some((word) => word === "-b" || word === "--detach")) {
      throw new Error("The browser bridge attaches an existing branch only. Run `git branch <name>` first, then `git worktree add <path> <name>`.");
    }
    if (args.length !== 3) throw new Error("Use `git worktree add <path> <branch>` in the browser bridge.");
    const path = normalizeWorkspacePath(resolveCwd(cwd, args[1]!));
    const latest = await requireLatest(client, repository, signal);
    const operation: GitOperation = {
      kind: "worktree-create",
      request: {
        repositoryId: repository.id,
        worktreeId: uniqueIdentifier(path.split("/").filter(Boolean).at(-1) ?? "worktree", latest.worktrees.map((item) => item.id)),
        path,
        branch: args[2]!,
        expectedRepositoryVersion: latest.version,
      },
    };
    await approve(operation, review);
    const created = await client.createWorktree(operation.request, signal);
    return result(`Prepared worktree ${operation.request.worktreeId} at ${path} on ${args[2]}.`, Boolean(created));
  }
  if (verb === "remove") {
    if (args.length !== 2) throw new Error("Use `git worktree remove <path>` in the browser bridge.");
    const path = normalizeWorkspacePath(resolveCwd(cwd, args[1]!));
    const latest = await requireLatest(client, repository, signal);
    const found = latest.worktrees.find((item) => item.path === path);
    if (!found) throw new Error(`No linked worktree is registered at ${path}.`);
    const operation: GitOperation = {
      kind: "worktree-remove",
      request: { repositoryId: repository.id, worktreeId: found.id, expectedRepositoryVersion: latest.version },
    };
    await approve(operation, review);
    await client.removeWorktree(operation.request, signal);
    return result(`Removed worktree ${found.id} at ${path}.`, true);
  }
  throw new Error("The browser bridge supports `git worktree list|add <path> <branch>|remove <path>`.");
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
  // Tell the user the page policy blocks this host before an approval prompt
  // asks them to authorize a request that can never leave the browser.
  assertRemoteOriginPermitted(url.toString(), "clone");
  const base = url.pathname.replace(/\.git$/u, "").split("/").filter(Boolean).at(-1) ?? "repository";
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+/u, "repo-").slice(0, 72) || "repository";
  const id = uniqueIdentifier(`clone-${slug}`, repositories.map((item) => item.id));
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

/** Only speak the capability's own reason when the capability is genuinely off. */
function requireFeature(client: BrowserGitClient, capability: GitCapability, label: string): void {
  const state = client.capabilities.features[capability];
  if (!state.available) throw new Error(state.reason ?? `${label} is unavailable in this browser adapter.`);
}

async function requireLatest(
  client: BrowserGitClient,
  repository: GitRepositorySnapshot,
  signal: AbortSignal,
): Promise<GitRepositorySnapshot> {
  const latest = await client.getRepository(repository.id, signal);
  if (!latest) throw new Error(`Repository ${repository.id} disappeared before the command ran.`);
  return latest;
}

function uniqueIdentifier(base: string, taken: readonly string[]): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+/u, "id-").slice(0, 72) || "id";
  let candidate = slug;
  for (let suffix = 2; taken.includes(candidate); suffix += 1) candidate = `${slug}-${suffix}`;
  return candidate;
}

function takeFlag(words: string[], flag: string): boolean {
  // Options are only read before the `--` separator, so a path named
  // `--worktree` or `--source=HEAD` is never eaten as an option.
  const index = beforeSeparator(words).indexOf(flag);
  if (index < 0) return false;
  words.splice(index, 1);
  return true;
}

function stashIndex(value: string): number {
  const parsed = /^(?:stash@\{(\d+)\}|(\d+))$/u.exec(value);
  if (!parsed) throw new Error("Reference a stash entry as `stash@{n}` or `n`.");
  return Number(parsed[1] ?? parsed[2]);
}

function formatCommit(commit: GitCommitSummary, oneline: boolean): string {
  const subject = commit.message.split("\n", 1)[0] ?? "";
  if (oneline) return `${commit.oid.slice(0, 7)} ${subject}`;
  return [
    `commit ${commit.oid}`,
    `Author: ${commit.author.name} <${commit.author.email}>`,
    `Date:   ${commit.committedAt}`,
    "",
    ...commit.message.replace(/\n$/u, "").split("\n").map((line) => `    ${line}`),
  ].join("\n");
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

/**
 * Git stops reading options at the first `--`; every word after it is a
 * pathspec however odd it looks. Scan only the words before the separator so
 * `git restore -- --odd.txt` still discards the file literally named
 * `--odd.txt` instead of being refused as an unsupported flag.
 */
function unsupportedFlag(args: readonly string[]): string | undefined {
  return beforeSeparator(args).find((word) => word.startsWith("--"));
}

function beforeSeparator(args: readonly string[]): readonly string[] {
  const separator = args.indexOf("--");
  return separator < 0 ? args : args.slice(0, separator);
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
    "  git log [-n <count>] [--oneline] [<revision>] [-- <path>] | git show [<revision>]",
    "  git add [-f] <paths…> | git add -A",
    "  git restore --staged [paths…] | git reset [HEAD] [paths…]",
    "  git restore [--worktree] [--source=HEAD] <paths…> | git reset --soft|--mixed|--hard <revision>",
    "  git commit -m \"message\"",
    "  git branch [name] | git switch [-c] <name> | git merge [--ff-only] <branch>",
    "  git stash [push [-m \"message\"]|list|pop|apply|drop|clear] [stash@{n}]",
    "  git tag [-l] | git tag [-a] <name> [-m \"message\"] [<revision>] | git tag -d <name>",
    "  git worktree list | git worktree add <path> <branch> | git worktree remove <path>",
    "  git remote [-v] | git remote add|set-url <name> <https-url> | git remote remove <name>",
    "  git fetch [remote] | git push [remote] [branch]",
    "  git clone <https-url> [workspace-destination]",
    "  git rev-parse HEAD|--show-toplevel|--is-inside-work-tree",
    "Not implemented here: rebase, cherry-pick, revert, blame, bisect, submodules, notes.",
    "Remote traffic is direct Smart HTTP with no proxy or Airship backend. This build's own Content-Security-Policy also decides which origins the page may reach; `git_inspect capabilities` lists them.",
  ].join("\n");
}

function result(output: string, changed: boolean): TerminalGitResult {
  const bounded = output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated …` : output;
  return Object.freeze({ output: bounded.replace(/\n?$/u, "\n"), changed });
}
