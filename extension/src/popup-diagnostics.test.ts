import { describe, expect, it } from "vitest";
import { callerAllowlist } from "./policy";
import { describePopupChannel, diagnoseCurrentTab } from "./popup-diagnostics";

describe("popup build diagnostics", () => {
  it("names the exact build channel and caller rules", () => {
    expect(describePopupChannel("release", callerAllowlist("release"))).toEqual({
      channel: "release",
      label: "Release",
      callerRules: ["https://sirouk.github.io/airship/"],
      connectionUrl: "https://sirouk.github.io/airship/#connection",
    });
    expect(describePopupChannel("development", callerAllowlist("development"))).toEqual({
      channel: "development",
      label: "Development",
      callerRules: [
        "https://sirouk.github.io/airship/",
        "http://localhost:4173/",
        "http://127.0.0.1:4173/",
      ],
      connectionUrl: "http://localhost:4173/#connection",
    });
  });

  it("reports allowlist compatibility without claiming a live relay", () => {
    const callers = callerAllowlist("development");
    expect(diagnoseCurrentTab("http://localhost:4173/#connection", callers)).toEqual({
      state: "allowlisted",
      label: "Current tab is in this build's caller allowlist",
      origin: "http://localhost:4173",
    });
    expect(diagnoseCurrentTab("http://localhost:4174/#connection", callers)).toEqual({
      state: "not-allowlisted",
      label: "Current tab is outside this build's caller allowlist",
      origin: "http://localhost:4174",
    });
    expect(diagnoseCurrentTab("https://example.com/", callers)).toMatchObject({
      state: "not-allowlisted",
      origin: "https://example.com",
    });
  });

  it("keeps a missing active-tab grant visibly unknown", () => {
    expect(diagnoseCurrentTab(undefined, callerAllowlist("release"))).toEqual({
      state: "unavailable",
      label: "Current tab address is not available",
      origin: "Not exposed by this browser",
    });
  });
});
