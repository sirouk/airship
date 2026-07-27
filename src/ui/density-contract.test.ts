import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const styles = await readAirshipStyles();

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
