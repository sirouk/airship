import type { JsonValue, Tool } from "../core/contracts";
import type { BrowserGitClient, GitDiffScope } from "../git";
import type { ToolRegistry } from "./registry";

export function registerGitTools(registry: ToolRegistry, client: BrowserGitClient): void {
  const inspect: Tool = {
    definition: {
      name: "git_inspect",
      description: "Inspect the browser-owned Git adapter, repositories, status, or an exact staged/worktree diff.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["capabilities", "repositories", "status", "diff"] },
          repositoryId: { type: "string", maxLength: 256 },
          worktreeId: { type: "string", maxLength: 256 },
          path: { type: "string", maxLength: 4_096 },
          scope: { type: "string", enum: ["staged", "worktree"] },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const action = stringArgument(args.action, "action");
      if (action === "capabilities") return jsonResult(client.capabilities);
      if (action === "repositories") return jsonResult(await client.listRepositories(context.signal));
      const repositoryId = stringArgument(args.repositoryId, "repositoryId");
      const worktreeId = stringArgument(args.worktreeId, "worktreeId");
      if (action === "status") return jsonResult(await client.status({ repositoryId, worktreeId }, context.signal));
      if (action === "diff") {
        const path = stringArgument(args.path, "path");
        const scope = (args.scope ?? "worktree") as GitDiffScope;
        return jsonResult(await client.diff({ repositoryId, worktreeId, path, scope }, context.signal));
      }
      throw new Error(`Unsupported Git inspection action: ${action}.`);
    },
  };

  const change: Tool = {
    definition: {
      name: "git_change",
      description: "Stage, unstage, commit, create, or switch branches in the browser-owned Git adapter.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["stage", "unstage", "commit", "create_branch", "switch_branch"] },
          repositoryId: { type: "string", maxLength: 256 },
          worktreeId: { type: "string", maxLength: 256 },
          expectedWorktreeVersion: { type: "string", maxLength: 256 },
          paths: { type: "array", items: { type: "string", maxLength: 4_096 }, maxItems: 2_048, uniqueItems: true },
          message: { type: "string", maxLength: 16_384 },
          authorName: { type: "string", maxLength: 256 },
          authorEmail: { type: "string", maxLength: 512 },
          branch: { type: "string", maxLength: 1_024 },
          startPoint: { type: "string", maxLength: 1_024 },
          checkout: { type: "boolean" },
        },
        required: ["action", "repositoryId", "worktreeId", "expectedWorktreeVersion"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const action = stringArgument(args.action, "action");
      const repositoryId = stringArgument(args.repositoryId, "repositoryId");
      const worktreeId = stringArgument(args.worktreeId, "worktreeId");
      const expectedWorktreeVersion = stringArgument(args.expectedWorktreeVersion, "expectedWorktreeVersion");
      if (action === "stage" || action === "unstage") {
        const paths = stringArray(args.paths, "paths");
        const request = { repositoryId, worktreeId, expectedWorktreeVersion, paths };
        return jsonResult(action === "stage"
          ? await client.stage(request, context.signal)
          : await client.unstage(request, context.signal));
      }
      if (action === "commit") {
        return jsonResult(await client.commit({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          message: stringArgument(args.message, "message"),
          author: {
            name: optionalString(args.authorName) ?? "Airship User",
            email: optionalString(args.authorEmail) ?? "airship@local.invalid",
          },
        }, context.signal));
      }
      if (action === "create_branch") {
        return jsonResult(await client.createBranch({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          name: stringArgument(args.branch, "branch"),
          ...(optionalString(args.startPoint) ? { startPoint: optionalString(args.startPoint) } : {}),
          ...(typeof args.checkout === "boolean" ? { checkout: args.checkout } : {}),
        }, context.signal));
      }
      if (action === "switch_branch") {
        return jsonResult(await client.switchBranch({
          repositoryId,
          worktreeId,
          expectedWorktreeVersion,
          name: stringArgument(args.branch, "branch"),
        }, context.signal));
      }
      throw new Error(`Unsupported Git change action: ${action}.`);
    },
  };

  const remote: Tool = {
    definition: {
      name: "git_remote",
      description: "Clone a real Git repository or fetch its remote directly from this browser. Remote Smart HTTP must permit browser CORS; Airship never inserts a proxy.",
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
      const action = stringArgument(args.action, "action");
      const repositoryId = stringArgument(args.repositoryId, "repositoryId");
      if (action === "clone") {
        return jsonResult(await client.clone({
          repositoryId,
          name: stringArgument(args.name, "name"),
          remoteUrl: stringArgument(args.remoteUrl, "remoteUrl"),
          remoteName: optionalString(args.remoteName) ?? "origin",
          ...(optionalString(args.defaultBranch) ? { defaultBranch: optionalString(args.defaultBranch) } : {}),
          destination: stringArgument(args.destination, "destination"),
        }, context.signal));
      }
      if (action === "fetch") {
        return jsonResult(await client.fetch({
          repositoryId,
          remote: optionalString(args.remote) ?? "origin",
          expectedRepositoryVersion: stringArgument(args.expectedRepositoryVersion, "expectedRepositoryVersion"),
          prune: args.prune === true,
        }, context.signal));
      }
      throw new Error(`Unsupported Git remote action: ${action}.`);
    },
  };

  registry.register(inspect);
  registry.register(change);
  registry.register(remote);
}

function jsonResult(value: unknown) {
  return { content: JSON.stringify(value, null, 2) };
}

function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function stringArgument(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
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
