import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTENSION_PACKAGE_MEMBERS,
  EXTENSION_RELEASE_FILES,
  readExtensionArchive,
} from "./release-archive.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "public", "extension", "releases");

describe("companion release packages", () => {
  it("cleans stale output, publishes exact packages, and keeps the install hub on their version", async () => {
    const staleBuild = resolve(root, "extension", "build", "release", "chromium", "stale-secret.map");
    await mkdir(resolve(staleBuild, ".."), { recursive: true });
    await writeFile(staleBuild, `const key = "AKIA${"Z".repeat(16)}";\n//# sourceMappingURL=stale.map\n`);
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(resolve(releaseRoot, "orphan-stale.zip"), "stale release");

    execFileSync(process.execPath, [resolve(root, "extension", "package.mjs")], { cwd: root, stdio: "pipe" });
    await expect(access(staleBuild)).rejects.toThrow();
    const releaseEntries = await readdir(releaseRoot, { withFileTypes: true });
    expect(releaseEntries.every((entry) => entry.isFile())).toBe(true);
    expect(releaseEntries.map(({ name }) => name).sort()).toEqual([...EXTENSION_RELEASE_FILES]);

    const metadata = JSON.parse(await readFile(resolve(releaseRoot, "release.json"), "utf8"));
    const checksums = await readFile(resolve(releaseRoot, "SHA256SUMS"), "utf8");
    const installHub = await readFile(resolve(root, "public", "extension", "index.html"), "utf8");

    expect(metadata.schema).toBe("airship-companion-release:1");
    expect(metadata.artifacts).toHaveLength(6);
    expect(installHub).toContain(`Airship Companion · ${metadata.version}`);
    // With JavaScript unavailable the safe published-origin default remains
    // the release package. The runtime hub promotes the exact development
    // artifact only after observing localhost:4173.
    expect(installHub).toContain('href="./releases/airship-companion-chromium-release.zip"');
    expect(installHub).toContain(
      'data-development-href="./releases/airship-companion-chromium-development.zip"',
    );

    for (const artifact of metadata.artifacts) {
      const bytes = await readFile(resolve(releaseRoot, artifact.file));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
      expect(readExtensionArchive(artifact.file, bytes).map(({ path }) => path))
        .toEqual([...EXTENSION_PACKAGE_MEMBERS]);
      expect(bytes.byteLength).toBe(artifact.bytes);
      expect(digest).toBe(artifact.sha256);
      expect(checksums).toContain(`${digest}  ${artifact.file}`);
    }
  });
});
