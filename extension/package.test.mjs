import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "public", "extension", "releases");

describe("companion release packages", () => {
  it("publishes six checksum-bound artifacts and keeps the install hub on their version", async () => {
    const metadata = JSON.parse(await readFile(resolve(releaseRoot, "release.json"), "utf8"));
    const checksums = await readFile(resolve(releaseRoot, "SHA256SUMS"), "utf8");
    const installHub = await readFile(resolve(root, "public", "extension", "index.html"), "utf8");

    expect(metadata.schema).toBe("airship-companion-release:1");
    expect(metadata.artifacts).toHaveLength(6);
    expect(installHub).toContain(`Airship Companion · ${metadata.version}`);

    for (const artifact of metadata.artifacts) {
      const bytes = await readFile(resolve(releaseRoot, artifact.file));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
      expect(bytes.byteLength).toBe(artifact.bytes);
      expect(digest).toBe(artifact.sha256);
      expect(checksums).toContain(`${digest}  ${artifact.file}`);
    }
  });
});
