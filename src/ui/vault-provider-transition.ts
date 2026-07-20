import type { VaultBackend } from "./platform-shell";

export type VaultProviderTransition = Readonly<{
  current: VaultBackend;
  next: VaultBackend;
  runtimeUsesVault(): boolean;
  adoptEphemeralRuntime(): Promise<void>;
  disconnectAuthority(): void;
  commitPreference(next: VaultBackend): void;
}>;

/** Quiesce the old store before resetting its authority or publishing a new provider. */
export async function transitionVaultProvider(input: VaultProviderTransition): Promise<"changed" | "unchanged"> {
  if (input.current === input.next) return "unchanged";
  if (input.runtimeUsesVault()) await input.adoptEphemeralRuntime();
  if (input.runtimeUsesVault()) throw new Error("Vault provider switch stopped because the active runtime still references the prior store.");
  input.disconnectAuthority();
  input.commitPreference(input.next);
  return "changed";
}
