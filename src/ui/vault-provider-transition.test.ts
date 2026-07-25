import { describe, expect, it, vi } from "vitest";
import { releaseVaultAuthority, transitionVaultProvider } from "./vault-provider-transition";

describe("vault provider transition", () => {
  it.each([
    ["google-drive", "local-lab"],
    ["local-lab", "google-drive"],
    ["google-drive", "ephemeral"],
  ] as const)("quiesces %s before selecting %s", async (current, next) => {
    let workspaceId = current === "google-drive" ? "vault+gdrive://old" : "vault+s3://old";
    const order: string[] = [];
    await transitionVaultProvider({
      current,
      next,
      runtimeUsesVault: () => workspaceId.startsWith("vault+"),
      adoptEphemeralRuntime: async () => { order.push("migrate"); workspaceId = "memory://airship-page"; },
      disconnectAuthority: () => order.push("disconnect"),
      commitPreference: (provider) => order.push(`preference:${provider}`),
    });
    expect(workspaceId).toBe("memory://airship-page");
    expect(order).toEqual(["migrate", "disconnect", `preference:${next}`]);
  });

  it("fails closed if migration leaves the old store active", async () => {
    const events: string[] = [];
    await expect(transitionVaultProvider({
      current: "google-drive",
      next: "local-lab",
      runtimeUsesVault: () => true,
      adoptEphemeralRuntime: async () => { events.push("migrate"); },
      disconnectAuthority: () => events.push("disconnect"),
      commitPreference: () => events.push("preference"),
    })).rejects.toThrow("still references");
    expect(events).toEqual(["migrate"]);
  });

  it("releases an adopted runtime before a same-provider disconnect", async () => {
    let workspaceId = "vault+gdrive://active";
    const order: string[] = [];
    await releaseVaultAuthority({
      runtimeUsesVault: () => workspaceId.startsWith("vault+"),
      adoptEphemeralRuntime: async () => {
        order.push("migrate");
        workspaceId = "memory://airship-page";
      },
      disconnectAuthority: () => order.push("disconnect"),
    });
    expect(workspaceId).toBe("memory://airship-page");
    expect(order).toEqual(["migrate", "disconnect"]);
  });

  it("does not clear authority when a disconnect migration fails closed", async () => {
    const disconnect = vi.fn();
    await expect(releaseVaultAuthority({
      runtimeUsesVault: () => true,
      adoptEphemeralRuntime: async () => undefined,
      disconnectAuthority: disconnect,
    })).rejects.toThrow("disconnect stopped");
    expect(disconnect).not.toHaveBeenCalled();
  });
});
