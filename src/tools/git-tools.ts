import { objectArguments, requiredString } from "./schema";
import type { JsonValue, Tool } from "../core/contracts";
import type { BrowserGitClient, GitDiffScope } from "../git";
// Imported from the module rather than the barrel: the barrel re-exports the
// simulated memory adapter, and this tool bundle must not pull it in.
import { GIT_LIMITS } from "../git/validation";
import type { ToolRegistry } from "./registry";

export function registerGitTools(registry: ToolRegistry, client: BrowserGitClient): void {
  const inspect: Tool = {
    definition: {
      name: "git_inspect",
      description: "Inspect the browser-owned Git adapter: capabilities, repositories, status, an exact staged/worktree diff, commit history, one commit's patch, tags, or stash entries.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["capabilities", "repositories", "status", "diff", "log", "show", "tags", "stash"] },
          repositoryId: { type: "string", maxLength: 256 },
          worktreeId: { type: "string", maxLength: 256 },
          path: { type: "string", maxLength: 4_096 },
          scope: { type: "string", enum: ["staged", "worktree"] },
          revision: { type: "string", maxLength: 1_024 },
          depth: { type: "integer", minimum: 1, maximum: GIT_LIMITS.maxLogDepth },
          follow: { type: "boolean" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const action = requiredString(args.action, "action");
      if (action === "capabilities") return jsonResult(client.capabilities);
      if (action === "repositories") return jsonResult(await client.listRepositories(context.signal));
      const repositoryId = requiredString(args.repositoryId, "repositoryId");
      if (action === "tags") return jsonResult(await client.listTags(repositoryId, context.signal));
      const worktreeId = requiredString(args.worktreeId, "worktreeId");
      if (action === "status") return jsonResult(await client.status({ repositoryId, worktreeId }, context.signal));
      if (action === "stash") return jsonResult(await client.listStash({ repositoryId, worktreeId }, context.signal));
      if (action === "diff") {
        const path = requiredString(args.path, "path");
        const scope = (args.scope ?? "worktree") as GitDiffScope;
        return jsonResult(await client.diff({ repositoryId, worktreeId, path, scope }, context.signal));
      }
      if (action === "log") {
        return jsonResult(await client.log({
          repositoryId,
          worktreeId,
          ...(optionalString(args.revision) ? { ref: optionalString(args.revision) } : {}),
          ...(typeof args.depth === "number" ? { depth: args.depth } : {}),
          ...(optionalString(args.path) ? { path: optionalString(args.path), follow: args.follow === true } : {}),
        }, context.signal));
      }
      if (action === "show") {
        return jsonResult(await client.show({
          repositoryId,
          worktreeId,
          revision: requiredString(args.revision, "revision"),
        }, context.signal));
      }
      throw new Error(`Unsupported Git inspection action: ${action}.`);
    },
  };

  const change: Tool = {
    definition: {
      name: "git_change",
      description: "Change the browser-owned Git worktree: stage, unstage, commit, branch, merge, stash, discard worktree changes, or reset the current branch.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["stage", "unstage", "commit", "create_branch", "switch_branch", "merge", "stash", "restore", "reset"],
          },
          repositoryId: { type: "string", maxLength: 256 },
          worktreeId: { type: "string", maxLength: 256 },
          expectedWorktreeVersion: { type: "string", maxLength: 256 },
          paths: { type: "array", items: { type: "string", maxLength: 4_096 }, maxItems: GIT_LIMITS.maxPathsPerRequest, uniqueItems: true },
          message: { type: "string", maxLength: 16_384 },
          authorName: { type: "string", maxLength: 256 },
          authorEmail: { type: "string", maxLength: 512 },
          branch: { type: "string", maxLength: 1_024 },
          startPoint: { type: "string", maxLength: 1_024 },
          checkout: { type: "boolean" },
          /** Stage a path the repository's own ignore rules exclude. */
          force: { type: "boolean" },
          revision: { type: "string", maxLength: 1_024 },
          fastForwardOnly: { type: "boolean" },
          mode: { type: "string", enum: ["soft", "mixed", "hard"] },
          source: { type: "string", enum: ["stage", "head"] },
          stashOp: { type: "string", enum: ["push", "apply", "pop", "drop", "clear"] },
          stashIndex: { type: "integer", minimum: 0, maximum: GIT_LIMITS.maxStashEntries - 1 },
        },
        required: ["action", "repositoryId", "worktreeId", "expectedWorktreeVersion"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const action = requiredString(args.action, "action");
      const repositoryId = requiredString(args.repositoryId, "repositoryId");
      const worktreeId = requiredString(args.worktreeId, "worktreeId");
      const expectedWorktreeVersion = requiredString(args.expectedWorktreeVersion, "expectedWorktreeVersion");
      const author = {
        name: optionalString(args.authorName) ?? "Airship User",
        email: optionalString(args.authorEmail) ?? "airship@local.invalid",
      };
      if (action === "stage" || action === "unstage") {
        const paths = stringArray(args.paths, "paths");
        const request = { repositoryId, worktreeId, expectedWorktreeVersion, paths };
        return jsonResult(action === "stage"
          ? await client.stage({ ...request, ...(args.force === true ? { force: true } : {}) }, context.signal)
          : await client.unstage(request, context.signal));
      }
      if (action === "merge") {
        return jsonResult(await client.merge({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          theirs: requiredString(args.branch, "branch"),
          fastForwardOnly: args.fastForwardOnly === true,
          ...(optionalString(args.message) ? { message: optionalString(args.message) } : {}),
          author,
        }, context.signal));
      }
      if (action === "stash") {
        return jsonResult(await client.stash({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          op: (optionalString(args.stashOp) ?? "push") as "push",
          ...(optionalString(args.message) ? { message: optionalString(args.message) } : {}),
          ...(typeof args.stashIndex === "number" ? { index: args.stashIndex } : {}),
          author,
        }, context.signal));
      }
      if (action === "restore") {
        return jsonResult(await client.restore({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          paths: stringArray(args.paths, "paths"),
          source: args.source === "head" ? "head" : "stage",
        }, context.signal));
      }
      if (action === "reset") {
        return jsonResult(await client.reset({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          mode: (optionalString(args.mode) ?? "mixed") as "mixed",
          ref: requiredString(args.revision, "revision"),
        }, context.signal));
      }
      if (action === "commit") {
        return jsonResult(await client.commit({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          message: requiredString(args.message, "message"),
          author,
        }, context.signal));
      }
      if (action === "create_branch") {
        return jsonResult(await client.createBranch({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          name: requiredString(args.branch, "branch"),
          ...(optionalString(args.startPoint) ? { startPoint: optionalString(args.startPoint) } : {}),
          ...(typeof args.checkout === "boolean" ? { checkout: args.checkout } : {}),
        }, context.signal));
      }
      if (action === "switch_branch") {
        return jsonResult(await client.switchBranch({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          name: requiredString(args.branch, "branch"),
        }, context.signal));
      }
      throw new Error(`Unsupported Git change action: ${action}.`);
    },
  };

  const remote: Tool = {
    definition: {
      name: "git_remote",
      description: "Clone or fetch a real Git remote directly from this browser. Airship never inserts a proxy, and this build's own Content-Security-Policy limits which origins Git Smart HTTP can reach at all — read git_inspect capabilities.remote.permittedOrigins first.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["clone", "fetch"] },
          repositoryId: { type: "string", maxLength: 256 },
          name: { type: "string", maxLength: 512 },
          remoteUrl: { type: "string", maxLength: 4_096 },
          remoteName: { type: "string", maxLength: 256 },
          defaultBranch: { type: "string", maxLength: 1_024 },
          destination: { type: "string", maxLength: 4_096 },
          remote: { type: "string", maxLength: 256 },
          expectedRepositoryVersion: { type: "string", maxLength: 256 },
          prune: { type: "boolean" },
        },
        required: ["action", "repositoryId"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const action = requiredString(args.action, "action");
      const repositoryId = requiredString(args.repositoryId, "repositoryId");
      if (action === "clone") {
        return jsonResult(await client.clone({
          repositoryId,
          name: requiredString(args.name, "name"),
          remoteUrl: requiredString(args.remoteUrl, "remoteUrl"),
          remoteName: optionalString(args.remoteName) ?? "origin",
          ...(optionalString(args.defaultBranch) ? { defaultBranch: optionalString(args.defaultBranch) } : {}),
          destination: requiredString(args.destination, "destination"),
        }, context.signal));
      }
      if (action === "fetch") {
        return jsonResult(await client.fetch({
          repositoryId,
          remote: optionalString(args.remote) ?? "origin",
          expectedRepositoryVersion: requiredString(args.expectedRepositoryVersion, "expectedRepositoryVersion"),
          prune: args.prune === true,
        }, context.signal));
      }
      throw new Error(`Unsupported Git remote action: ${action}.`);
    },
  };

  // Attaching a remote or writing a tag changes .git/config and refs only; no
  // bytes leave the device, so it must not be declared as a network effect.
  const configure: Tool = {
    definition: {
      name: "git_configure",
      description: "Attach, repoint, or detach a repository's remotes, and create or delete tags. This writes .git/config and refs locally; it contacts no remote.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add_remote", "set_remote_url", "remove_remote", "create_tag", "delete_tag"] },
          repositoryId: { type: "string", maxLength: 256 },
          expectedRepositoryVersion: { type: "string", maxLength: 256 },
          name: { type: "string", maxLength: 512 },
          remoteUrl: { type: "string", maxLength: 4_096 },
          revision: { type: "string", maxLength: 1_024 },
          /** Present for an annotated tag object; absent creates a lightweight ref. */
          message: { type: "string", maxLength: 16_384 },
          authorName: { type: "string", maxLength: 256 },
          authorEmail: { type: "string", maxLength: 512 },
        },
        required: ["action", "repositoryId", "expectedRepositoryVersion", "name"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const action = requiredString(args.action, "action");
      const repositoryId = requiredString(args.repositoryId, "repositoryId");
      const name = requiredString(args.name, "name");
      const expectedRepositoryVersion = requiredString(args.expectedRepositoryVersion, "expectedRepositoryVersion");
      if (action === "add_remote" || action === "set_remote_url") {
        const request = { repositoryId, name, url: requiredString(args.remoteUrl, "remoteUrl"), expectedRepositoryVersion };
        return jsonResult(action === "add_remote"
          ? await client.addRemote(request, context.signal)
          : await client.setRemoteUrl(request, context.signal));
      }
      if (action === "remove_remote") {
        return jsonResult(await client.removeRemote({ repositoryId, name, expectedRepositoryVersion }, context.signal));
      }
      if (action === "delete_tag") {
        return jsonResult(await client.deleteTag({ repositoryId, name, expectedRepositoryVersion }, context.signal));
      }
      if (action === "create_tag") {
        const message = optionalString(args.message);
        return jsonResult(await client.createTag({
          repositoryId,
          name,
          ...(optionalString(args.revision) ? { ref: optionalString(args.revision) } : {}),
          ...(message === undefined ? {} : {
            message,
            author: {
              name: optionalString(args.authorName) ?? "Airship User",
              email: optionalString(args.authorEmail) ?? "airship@local.invalid",
            },
          }),
          expectedRepositoryVersion,
        }, context.signal));
      }
      throw new Error(`Unsupported Git configuration action: ${action}.`);
    },
  };

  registry.register(inspect);
  registry.register(change);
  registry.register(remote);
  registry.register(configure);
}

function jsonResult(value: unknown) {
  return { content: JSON.stringify(value, null, 2) };
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: JsonValue | undefined, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  return value.map((item) => (item as string).trim());
}
