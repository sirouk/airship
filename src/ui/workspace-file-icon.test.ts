import { describe, expect, it } from "vitest";
import { workspaceFileIconDescriptor } from "./workspace-file-icon";

describe("workspace file icon model", () => {
  it.each([
    ["/workspace/src/app.tsx", "typescript", "TS"],
    ["/workspace/types/runtime.d.ts", "typescript", "TS"],
    ["/workspace/src/worker.mjs", "javascript", "JS"],
    ["/workspace/package-lock.json", "json", "{}"],
    ["/workspace/docs/README.md", "markdown", "MD"],
    ["/workspace/index.html", "markup", "<>"],
    ["/workspace/styles/main.scss", "stylesheet", "CSS"],
    ["/workspace/scripts/audit.py", "python", "PY"],
    ["/workspace/Cargo.toml", "config", "CFG"],
    ["/workspace/.gitignore", "config", "CFG"],
    ["/workspace/public/mark.svg", "image", "IMG"],
    ["/workspace/bin/module.wasm", "binary", "01"],
  ] as const)("classifies %s as %s", (path, kind, mark) => {
    expect(workspaceFileIconDescriptor(path)).toMatchObject({ kind, mark });
  });

  it("matches extensions case-insensitively and has an honest text fallback", () => {
    expect(workspaceFileIconDescriptor("/workspace/SCREENSHOT.PNG").kind).toBe("image");
    expect(workspaceFileIconDescriptor("/workspace/NOTICE")).toMatchObject({ kind: "text", mark: "TXT" });
  });
});
