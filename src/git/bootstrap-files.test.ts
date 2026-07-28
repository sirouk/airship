import { describe, expect, it } from "vitest";
import { AIRSHIP_BOOTSTRAP_FILES } from "./workspace-adapter";

describe("Airship workspace bootstrap truth", () => {
  it("describes selected live providers without inventing a MinIO or Chutes default", () => {
    const content = Object.values(AIRSHIP_BOOTSTRAP_FILES).join("\n");
    expect(content).toContain("selected Vault");
    expect(content).toContain("selected authenticated provider or local runtime");
    expect(content).not.toMatch(/MinIO vault by default|Chutes owns inference/iu);
  });
});
