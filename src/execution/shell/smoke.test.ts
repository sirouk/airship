import { describe, expect, it } from "vitest";
import { runScript } from "./harness.test-helper";

describe("airship-sh smoke", () => {
  it("runs the simplest possible script", async () => {
    expect(await runScript("echo hello")).toMatchObject({ exitCode: 0, stdout: "hello\n", stderr: "" });
  });

  it("expands and pipes", async () => {
    const result = await runScript(`x=world\nprintf '%s %s\\n' hello "$x" | tr a-z A-Z`);
    expect(result).toMatchObject({ exitCode: 0, stdout: "HELLO WORLD\n" });
  });

  it("reads real workspace files", async () => {
    const result = await runScript("cat a.txt b.txt | wc -l", {
      "/workspace/a.txt": "one\ntwo\n",
      "/workspace/b.txt": "three\n",
    });
    expect(result.stdout.trim()).toBe("3");
  });
});
