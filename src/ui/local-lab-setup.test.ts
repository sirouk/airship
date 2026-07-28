import { describe, expect, it } from "vitest";
import { LOCAL_LAB_DEFAULT_ENDPOINT, LOCAL_LAB_FIELDS, localLabFieldForError } from "./local-lab-setup";

describe("mounted local lab defaults", () => {
  it("uses the same loopback endpoint as the full-system lab", () => {
    expect(LOCAL_LAB_DEFAULT_ENDPOINT).toBe("http://127.0.0.1:9900");
    expect(new URL(LOCAL_LAB_DEFAULT_ENDPOINT).hostname).toBe("127.0.0.1");
  });
});

describe("field-anchored configuration refusals", () => {
  it("anchors the reproduced loopback refusal to the endpoint that caused it", () => {
    expect(localLabFieldForError("Local-development vaults require a loopback S3 endpoint."))
      .toBe("endpoint");
    expect(localLabFieldForError("Airship recovery key must use the versioned format."))
      .toBeUndefined();
  });

  it("routes the other five refusal shapes to their own inputs", () => {
    expect(localLabFieldForError("Bucket names must be DNS-safe.")).toBe("bucket");
    expect(localLabFieldForError("Region is required.")).toBe("region");
    expect(localLabFieldForError("Private namespace must not escape its prefix.")).toBe("namespace");
    expect(localLabFieldForError("Secret access key is required.")).toBe("secretAccessKey");
    expect(localLabFieldForError("Access key is required.")).toBe("accessKeyId");
  });

  it("declines to guess a field when the refusal names none", () => {
    // Pinning an unmatched refusal to an arbitrary input would tell a user to
    // change something that is not wrong. The summary keeps it instead.
    expect(localLabFieldForError("The vault coordinator refused the handoff.")).toBeUndefined();
  });

  it("keeps one label per configurable field", () => {
    expect(LOCAL_LAB_FIELDS).toEqual([
      "endpoint", "region", "bucket", "namespace", "accessKeyId", "secretAccessKey",
    ]);
  });
});
