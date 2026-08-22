/**
 * Airship's capability pack is a genuine dynamic boundary. The interactive
 * shell stays small; the first advanced surface or agent turn downloads one
 * cacheable pack instead of dozens of individually compressed fragments.
 *
 * Keep this module free of side effects. Its exports are the reviewed lazy
 * capabilities used by route wrappers and runtime coordinators.
 *
 * The loopback storage lab is deliberately absent from this list. Everything a
 * stock build cannot use — the S3 object store, the lab's configure request,
 * its setup panel and that panel's stylesheet — is reached instead through the
 * `LOCAL_LAB_BUILD` branches in `vault/coordinator.ts` and `ui/app.tsx`, so a
 * stock artifact does not carry it in this pack or anywhere else.
 */
export { auditSessionHistory } from "./core/session-audit";
export { journalSessionRePin } from "./sessions/session-repin";
export { CanvasMemoryGraphSurface } from "./memory-graph/canvas-renderer";
export { EncryptedObjectJournalBackend } from "./storage/encrypted-object-journal";
export { EncryptedProfileCatalogStore } from "./profiles/persistence";
export { runObjectStoreConformance } from "./storage/conformance";
export {
  GOOGLE_ACCOUNT_SCOPES,
  GOOGLE_DRIVE_FILE_SCOPE,
  GoogleIdentityServicesAuthorizer,
  MemoryOnlyGoogleAccessTokenProvider,
  readGoogleAccountIdentity,
} from "./storage/google-drive-auth";
export { GoogleDriveObjectStore } from "./storage/google-drive-object-store";
export { GoogleDriveWorkspaceManager } from "./storage/google-drive-workspace";
export {
  destroyLocalDeviceAuthority,
  LocalDeviceObjectStore,
  openLocalDeviceObjectStore,
  requestPersistentLocalDeviceStorage,
} from "./storage/local-device-object-store";
export {
  importLocalDeviceWorkspaceRecoveryKey,
  openLocalDeviceWorkspaceKey,
  prepareLocalDeviceWorkspaceKeyEnrollment,
} from "./storage/local-device-keyring";
export { createClientCiphertextCache } from "./storage/client-ciphertext-cache";
export { CiphertextCachingObjectStore } from "./storage/caching-object-store";
export { GoogleDriveSetup } from "./ui/google-drive-setup";
export {
  describeSessionPresentationFault,
  presentSessionMessages,
} from "./ui/chat/session-message-presentation";
export { ContextView } from "./ui/context-view";
export {
  WorkspaceRecoveryMaterial,
  importWorkspaceRecoveryKey,
} from "./vault/recovery";
export {
  adoptionCarriedNote,
  migrateJournalState,
  migrateProfileCatalogState,
  migrateWorkspaceState,
  readAdoptionCarriedWork,
  reconcileAdoptedProfileCatalog,
} from "./vault/runtime-adoption";
export type { AdoptionCarriedWork } from "./vault/runtime-adoption";
export { EncryptedObjectWorkspace } from "./vault/encrypted-workspace";
export { VaultContextFabricPort } from "./vault/context-fabric-port";
export {
  DEFAULT_RECLAMATION_SAFETY_AGE_MS,
  runVaultReclamationSweep,
} from "./vault/reclamation";
export { VaultReclamationQueue } from "./vault/reclamation-queue";
export {
  openLocalDeviceVault,
  restoreLocalDeviceVaultBackup,
} from "./vault/local-device";
export { SourcesView } from "./ui/sources-view";
