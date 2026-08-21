import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_LAB_BUILD } from "../local-lab-build";
import { providerProfilesForSelector } from "./vault-view";
import { STOCK_VAULT_BACKENDS, vaultBackendsForSelector } from "./platform-shell";

/*
 * The storage picker, in both builds this repository produces.
 *
 * `npm test` runs the suite as a lab build and `npm run test:stock` runs this
 * file plus the three picker suites as a stock build, so every claim below is
 * checked in the mode it describes rather than in whichever mode the harness
 * happened to be in.
 *
 * The rule the product has to keep is not "hide the lab". It is: say plainly
 * which destinations exist, and never name one this artifact cannot open. A
 * stock build therefore states three destinations and mentions no fourth; a
 * lab build states four on loopback and three anywhere else.
 */

const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
const loopback = { hostname: "localhost" } as const;
const publicOrigin = { hostname: "airship.example" } as const;
const configuredClientId = "123456789012-airship.apps.googleusercontent.com";

describe("the storage picker states exactly the destinations this build can open", () => {
  it("names the three stock destinations in both builds", () => {
    expect(STOCK_VAULT_BACKENDS).toEqual(["ephemeral", "local-device", "google-drive"]);
    const configured = vaultBackendsForSelector({ googleClientId: configuredClientId, location: publicOrigin });
    expect(configured).toEqual(["ephemeral", "local-device", "google-drive"]);
  });

  it("offers the lab only where the lab exists", () => {
    const offered = vaultBackendsForSelector({ location: loopback, localLabEnabled: true });
    expect(offered.includes("local-lab")).toBe(LOCAL_LAB_BUILD);
    // Composition never makes a public origin a lab origin, in either build.
    expect(vaultBackendsForSelector({ location: publicOrigin, localLabEnabled: true }))
      .toEqual(["ephemeral", "local-device"]);
  });

  it("keeps the comparison table and the control on one filtered set", () => {
    for (const availability of [
      { location: loopback, localLabEnabled: true },
      { location: loopback, localLabEnabled: false },
      { location: publicOrigin, googleClientId: configuredClientId, localLabEnabled: true },
    ]) {
      const columns = providerProfilesForSelector(availability).map((profile) => profile.id);
      expect(columns).toEqual([...vaultBackendsForSelector(availability)]);
    }
  });

  it("advertises no loopback lab from a stock build", () => {
    if (LOCAL_LAB_BUILD) return;
    const columns = providerProfilesForSelector({ location: loopback, localLabEnabled: true });
    const words = columns.flatMap((profile) => [
      profile.title,
      profile.description,
      profile.note,
      ...Object.values(profile.facts),
    ]).join(" ");
    expect(words).not.toMatch(/minio|loopback|s3-compatible/iu);
  });
});

describe("the lab is a build input, not a runtime branch", () => {
  it("replaces the opt-in with a literal so the branches fold", () => {
    expect(viteConfig).toContain('"import.meta.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB": JSON.stringify(LOCAL_LAB_ENABLED ? "1" : "0")');
    expect(viteConfig).toContain('const LOCAL_LAB_ENABLED = process.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB === "1"');
  });

  it("names every module only a lab build may contain", () => {
    // Folding the caller is not enough on its own: the bundler still emits a
    // chunk for a dynamic import it has parsed. These four are externalized in
    // a stock build so no chunk is created for them at all.
    for (const module of [
      "/src/storage/s3-object-store.ts",
      "/src/ui/local-lab-setup.tsx",
      "/src/ui/local-lab-vault.ts",
      "/src/vault/local-lab.ts",
    ]) {
      expect(viteConfig).toContain(`"${module}"`);
    }
  });

  it("reads the flag exactly once, where the bundler can see it", () => {
    const build = readFileSync(new URL("../local-lab-build.ts", import.meta.url), "utf8");
    expect(build).toContain('import.meta.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB === "1"');
    expect(LOCAL_LAB_BUILD).toBe(process.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB === "1");
  });
});
