import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

describe("global density contract", () => {
  it("defines systemic comfortable and compact tokens", () => {
    const comfortable = densityBlock("comfortable");
    const compact = densityBlock("compact");
    for (const token of ["--density-control", "--density-row", "--density-gap", "--density-panel-pad", "--density-chat-measure", "--density-sidebar", "--lh-body"]) {
      expect(comfortable).toContain(token);
      expect(compact).toContain(token);
    }
    expect(styles).toContain(":root[data-density] .message-body");
    expect(styles).toContain(":root[data-density] .composer textarea");
    expect(styles).toContain(":root[data-density] .profile-form");
  });
});

function densityBlock(name: string): string {
  const match = styles.match(new RegExp(`:root\\[data-density="${name}"\\]\\s*\\{([^}]+)\\}`, "u"));
  return match?.[1] ?? "";
}
