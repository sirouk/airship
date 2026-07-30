import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { downloadBytes, downloadFileName, downloadText } from "./file-download";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

describe("download filenames", () => {
  it("keeps the basename and nothing that could act as a path", () => {
    expect(downloadFileName("/workspace/docs/architecture.md")).toBe("architecture.md");
    expect(downloadFileName("/workspace/.gitkeep")).toBe(".gitkeep");
    // `anchor.download` is a filename, not a path: a separator in it is either
    // ignored or rewritten by the browser, so it never reaches the platform.
    expect(downloadFileName("/workspace/notes/2026/plan.md")).toBe("plan.md");
    expect(downloadFileName("a\\b\\report.csv")).toBe("report.csv");
  });

  it("strips control characters rather than passing them to the platform", () => {
    const hostile = `/workspace/re${String.fromCodePoint(13)}port${String.fromCodePoint(10)}.txt`;
    expect(downloadFileName(hostile)).toBe("report.txt");
    expect(downloadFileName(`/workspace/${String.fromCodePoint(127)}notes.md`)).toBe("notes.md");
  });

  it("falls back rather than emitting an empty or relative name", () => {
    expect(downloadFileName("/workspace/")).toBe("workspace");
    expect(downloadFileName("")).toBe("workspace-file");
    expect(downloadFileName("/")).toBe("workspace-file");
    expect(downloadFileName(`/workspace/${String.fromCodePoint(9)}`)).toBe("workspace-file");
  });
});

type StubAnchor = {
  href: string;
  download: string;
  rel: string;
  hidden: boolean;
  attached: boolean;
  clicks: number;
  click: () => void;
  remove: () => void;
};

type DownloadRecording = Readonly<{
  anchors: readonly StubAnchor[];
  blobs: readonly Blob[];
  urls: readonly string[];
  revoked: readonly string[];
}>;

describe("browser downloads", () => {
  // The revoke is deferred by a macrotask, so it has to land inside the test
  // that armed it — otherwise it fires against the *next* test's stub and
  // reports a second revocation that never happened.
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreDownloadEnvironment();
  });

  it("hands the browser a detached copy of exactly the caller's bytes", async () => {
    const recording = stubDownloadEnvironment();
    // A view into the middle of a larger buffer: the neighbours on either side
    // are what a naive `new Blob([bytes])` would have shipped.
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9, 9]);
    downloadBytes(backing.subarray(2, 5), "report.bin");

    const [anchor] = recording.anchors;
    const [blob] = recording.blobs;
    expect(recording.anchors).toHaveLength(1);
    expect(anchor?.download).toBe("report.bin");
    expect(anchor?.href).toBe(recording.urls[0]);
    // `rel="noopener"` and a detached anchor: the element exists for one click
    // and must not survive as a live reference into this document.
    expect(anchor?.rel).toBe("noopener");
    expect(anchor?.clicks).toBe(1);
    expect(anchor?.attached).toBe(false);
    expect(blob?.type).toBe("application/octet-stream");
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("revokes the object URL it created, once, after the click", async () => {
    const recording = stubDownloadEnvironment();
    downloadText(`{"receipt":"1"}`, "receipt.json");

    // Revocation is deferred by a macrotask because revoking before the
    // browser has started the fetch cancels the download in Safari.
    expect(recording.revoked).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recording.revoked).toEqual([recording.urls[0]]);
    expect(recording.blobs[0]?.type).toBe("application/json");
    expect(await recording.blobs[0]?.text()).toBe(`{"receipt":"1"}`);
  });

  it("refuses rather than silently succeeding where the platform cannot download", () => {
    // No `document` at all — this test file's own environment. A Vault export
    // that returned quietly here would leave the user believing they hold a
    // backup they were never handed.
    expect(() => downloadBytes(Uint8Array.from([1]), "backup.airship-vault"))
      .toThrow("Browser download is unavailable.");

    stubDownloadEnvironment();
    Reflect.deleteProperty(URL, "createObjectURL");
    expect(() => downloadBytes(Uint8Array.from([1]), "backup.airship-vault"))
      .toThrow("Browser download is unavailable.");
  });
});

describe("download de-duplication", () => {
  it("keeps every object-URL download in the one module that owns the cleanup", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      if (file.endsWith("/ui/file-download.ts")) continue;
      const text = await readFile(file, "utf8");
      // `anchor.download = …` is the whole of a browser download: wherever it
      // appears is a second revoke and a second cleanup to keep in step, which
      // is exactly how `local-device-vault-setup` came to omit the `append`
      // that Firefox requires.
      if (/\.download\s*=/u.test(text)) offenders.push(relative(sourceRoot, file));
    }

    expect(offenders, "call downloadBytes/downloadText instead of building an anchor").toEqual([]);
  });
});

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

let createdObjectUrl: ((blob: Blob) => string) | undefined;

/**
 * The smallest DOM this module actually touches.
 *
 * Real `jsdom` is not in this project's unit lane, and the surface under test
 * is four calls wide — so the stub records them rather than emulating a
 * document, and the assertions can be about what reached the browser.
 */
function stubDownloadEnvironment(): DownloadRecording {
  const anchors: StubAnchor[] = [];
  const blobs: Blob[] = [];
  const urls: string[] = [];
  const revoked: string[] = [];
  createdObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL")?.value as typeof createdObjectUrl;

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      const url = `blob:airship/${String(urls.length)}`;
      urls.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => { revoked.push(url); },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        const anchor: StubAnchor = {
          href: "", download: "", rel: "", hidden: false, attached: false, clicks: 0,
          click: () => { anchor.clicks += 1; },
          remove: () => { anchor.attached = false; },
        };
        anchors.push(anchor);
        return anchor;
      },
      body: { append: (anchor: StubAnchor) => { anchor.attached = true; } },
    },
  });

  return Object.freeze({ anchors, blobs, urls, revoked });
}

function restoreDownloadEnvironment(): void {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  if (createdObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createdObjectUrl });
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  createdObjectUrl = undefined;
}
