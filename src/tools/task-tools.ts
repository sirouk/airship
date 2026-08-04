import { objectArguments, requiredString } from "./schema";
import type { JsonValue, TaskPlanEntry, Tool } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";
import type { ToolRegistry } from "./registry";

const TASK_PATH = "/workspace/.airship/tasks.json";
const MAX_TASKS = 64;

type TaskStatus = "pending" | "in_progress" | "blocked" | "completed";
type AirshipTask = Readonly<{ id: string; content: string; status: TaskStatus }>;

export function registerTaskTools(registry: ToolRegistry, workspace: WorkspacePort): void {
  const listTasks: Tool = {
    definition: {
      name: "list_tasks",
      description: "Read the session work plan from the private workspace.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      const stored = await workspace.read(TASK_PATH);
      const tasks = stored ? parseTasks(stored.content) : [];
      return {
        content: JSON.stringify({ tasks, active: tasks.find((task) => task.status === "in_progress") ?? null }, null, 2),
        metadata: { count: tasks.length, path: TASK_PATH, revision: stored?.revision ?? null },
      };
    },
  };

  const updateTasks: Tool = {
    definition: {
      name: "update_tasks",
      description: "Replace the bounded session work plan; use at most one in-progress task.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            maxItems: MAX_TASKS,
            uniqueItems: true,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1, maxLength: 80 },
                content: { type: "string", minLength: 1, maxLength: 1_000 },
                status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed"] },
              },
              required: ["id", "content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue) {
      const record = objectArguments(argumentsValue);
      if (!Array.isArray(record.tasks)) throw new Error("tasks must be an array.");
      const tasks = normalizeTasks(record.tasks);
      const current = await workspace.read(TASK_PATH);
      const next = await workspace.write(TASK_PATH, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`, {
        expectedRevision: current?.revision ?? null,
      });
      return {
        content: `Updated ${tasks.length} task${tasks.length === 1 ? "" : "s"}; ${tasks.filter((task) => task.status === "completed").length} complete.`,
        metadata: { count: tasks.length, path: next.path, revision: next.revision },
      };
    },
  };

  registry.register(listTasks);
  registry.register(updateTasks);
  registry.attachTaskPlanProvider({
    async openTasks(context): Promise<readonly TaskPlanEntry[]> {
      context.signal.throwIfAborted();
      const stored = await workspace.read(TASK_PATH);
      // Throws on a malformed plan exactly as `list_tasks` does. The turn loop
      // turns that into a note telling the model its plan file is unreadable,
      // which is the one thing it can act on; swallowing it here would leave a
      // compaction silently forgetting a plan that is sitting right there.
      return stored ? parseTasks(stored.content).filter((task) => task.status !== "completed") : [];
    },
  });
}

function parseTasks(content: string): AirshipTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${TASK_PATH} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${TASK_PATH} is malformed.`);
  const tasks = (parsed as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) throw new Error(`${TASK_PATH} does not contain a task list.`);
  return normalizeTasks(tasks as JsonValue[]);
}

function normalizeTasks(values: JsonValue[]): AirshipTask[] {
  if (values.length > MAX_TASKS) throw new Error(`A work plan can contain at most ${MAX_TASKS} tasks.`);
  const ids = new Set<string>();
  let active = 0;
  const tasks = values.map((value): AirshipTask => {
    const item = objectArguments(value);
    const id = boundedString(item.id, "task id", 80);
    const content = boundedString(item.content, "task content", 1_000);
    const status = item.status;
    if (!["pending", "in_progress", "blocked", "completed"].includes(String(status))) {
      throw new Error(`Task ${id} has an invalid status.`);
    }
    if (ids.has(id)) throw new Error(`Task IDs must be unique: ${id}.`);
    ids.add(id);
    if (status === "in_progress") active += 1;
    return Object.freeze({ id, content, status: status as TaskStatus });
  });
  if (active > 1) throw new Error("A work plan can have at most one in-progress task.");
  return tasks;
}

/**
 * `requiredString` plus a length ceiling, under a name that says so.
 *
 * It was called `requiredString` here while five other tool modules used that
 * same name for the unbounded contract — the identical-name-different-contract
 * defect this pass exists to remove. The ceiling itself is real (a work plan is
 * journalled, so an unbounded task body is a durable-storage cost), so the
 * function stays; only its name and its shared half move.
 */
function boundedString(value: JsonValue | undefined, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${label} is invalid.`);
  return requiredString(value, label);
}
