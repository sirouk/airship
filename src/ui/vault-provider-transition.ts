import type { VaultBackend } from "./platform-shell";

export type VaultProviderTransition = Readonly<{
  current: VaultBackend;
  next: VaultBackend;
  runtimeUsesVault(): boolean;
  adoptEphemeralRuntime(): Promise<void>;
  disconnectAuthority(): void;
  commitPreference(next: VaultBackend): void;
}>;

export type VaultAuthorityRelease = Pick<
  VaultProviderTransition,
  "runtimeUsesVault" | "adoptEphemeralRuntime" | "disconnectAuthority"
>;

/** Copy live state out of the adopted vault before destroying its authority. */
export async function releaseVaultAuthority(input: VaultAuthorityRelease): Promise<void> {
  if (input.runtimeUsesVault()) await input.adoptEphemeralRuntime();
  if (input.runtimeUsesVault()) throw new Error("Vault disconnect stopped because the active runtime still references the prior store.");
  input.disconnectAuthority();
}

/** Quiesce the old store before resetting its authority or publishing a new provider. */
export async function transitionVaultProvider(input: VaultProviderTransition): Promise<"changed" | "unchanged"> {
  if (input.current === input.next) return "unchanged";
  await releaseVaultAuthority(input);
  input.commitPreference(input.next);
  return "changed";
}
