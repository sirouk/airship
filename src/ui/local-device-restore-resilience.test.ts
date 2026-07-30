import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

describe("local device restore resilience contract", () => {
  it("reopens the prior authority for a failed restore of either disposition", () => {
    // The restore handler closes the live IDB handle before the backup's
    // in-memory verification can reject it. On failure it used to reopen only
    // for "open-existing", while create-new reuses the enrolled key when it
    // proves equivalent — that path failed with the page bound to a closed
    // handle and no recovery.
    const handler = app.slice(
      app.indexOf("async function restoreLocalDeviceBackup("),
      app.indexOf("async function openFile("),
    );
    expect(handler).toContain("await handle.closeAndWait()");
    expect(handler).toContain("handleClosed = true");

    const recovery = handler.slice(handler.indexOf("} catch (error) {"));
    expect(recovery).toContain("if (handleClosed) {");
    expect(recovery).not.toContain('request.disposition === "open-existing"');
    expect(recovery).toContain('await activateLocalDeviceWorkspace(reopened, "restored")');
  });

  it("clears the live handle only as part of closing it", () => {
    // Dropping the reference without closing the authority would leak the
    // cross-tab lease; closing without reopening on failure is the defect
    // pinned above, so the two operations must stay adjacent.
    const handler = app.slice(
      app.indexOf("async function restoreLocalDeviceBackup("),
      app.indexOf("async function openFile("),
    );
    const close = handler.indexOf("await handle.closeAndWait()");
    const cleared = handler.indexOf("localDeviceHandle.current = undefined;");
    expect(close).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeGreaterThan(close);
    expect(handler.indexOf("setLocalDeviceStatus(undefined)")).toBeGreaterThan(close);
  });
});
